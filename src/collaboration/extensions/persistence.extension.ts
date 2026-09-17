import {
  afterUnloadDocumentPayload,
  Document,
  Extension,
  Hocuspocus,
  onChangePayload,
  onLoadDocumentPayload,
  onStoreDocumentPayload,
} from '@hocuspocus/server';
import * as Y from 'yjs';
import { Injectable, Logger } from '@nestjs/common';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { getPageId, jsonToText, tiptapExtensions } from '../collaboration.util';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { InjectQueue } from '@nestjs/bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { Queue } from 'bullmq';
import {
  extractMentions,
  extractUserMentions,
} from '../../common/helpers/prosemirror/utils';
import { isDeepStrictEqual } from 'node:util';
import {
  IPageHistoryJob,
  IPageMentionNotificationJob,
} from '../../integrations/queue/constants/queue.interface';
import { Page } from '@docmost/db/types/entity.types';
import { CollabHistoryService } from '../services/collab-history.service';
import {
  HISTORY_FAST_INTERVAL,
  HISTORY_FAST_THRESHOLD,
  HISTORY_INTERVAL,
} from '../constants';
import { TransclusionService } from '../../core/page/transclusion/transclusion.service';
import { LecAuthorizationService } from '../../core/lec-authorization/lec-authorization.service';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { LecCollabContext } from './authentication.extension';

type DirtyActor = {
  userId: string;
  capability: 'EDIT' | 'COMMENT';
  epoch: number;
};

@Injectable()
export class PersistenceExtension implements Extension {
  private readonly logger = new Logger(PersistenceExtension.name);
  private contributors = new Map<string, Map<string, DirtyActor>>();
  private epochs = new Map<string, number>();

  constructor(
    private readonly pageRepo: PageRepo,
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.HISTORY_QUEUE) private historyQueue: Queue,
    @InjectQueue(QueueName.NOTIFICATION_QUEUE) private notificationQueue: Queue,
    private readonly collabHistory: CollabHistoryService,
    private readonly transclusionService: TransclusionService,
    private readonly authorization: LecAuthorizationService,
    private readonly users: UserRepo,
  ) {}

  async onLoadDocument(data: onLoadDocumentPayload) {
    const { documentName, document } = data;
    const pageId = getPageId(documentName);

    if (!document.isEmpty('default')) {
      return;
    }

    const page = await this.pageRepo.findById(pageId, {
      includeContent: true,
      includeYdoc: true,
    });

    if (!page) {
      this.logger.warn('page not found');
      return;
    }

    if (page.ydoc) {
      this.logger.debug(`ydoc loaded from db: ${pageId}`);

      const doc = new Y.Doc();
      const dbState = new Uint8Array(page.ydoc);

      Y.applyUpdate(doc, dbState);
      return doc;
    }

    // if no ydoc state in db convert json in page.content to Ydoc.
    if (page.content) {
      this.logger.debug(`converting json to ydoc: ${pageId}`);

      const ydoc = TiptapTransformer.toYdoc(
        page.content,
        'default',
        tiptapExtensions,
      );

      Y.encodeStateAsUpdate(ydoc);
      return ydoc;
    }

    this.logger.debug(`creating fresh ydoc: ${pageId}`);
    return new Y.Doc();
  }

  async onStoreDocument(data: onStoreDocumentPayload) {
    const { documentName, document, lastContext } = data;

    const pageId = getPageId(documentName);
    const snapshot = new Y.Doc();
    Y.applyUpdate(snapshot, Y.encodeStateAsUpdate(document));

    const tiptapJson = TiptapTransformer.fromYdoc(snapshot, 'default');
    const ydocState = Buffer.from(Y.encodeStateAsUpdate(snapshot));

    let textContent = null;

    try {
      textContent = jsonToText(tiptapJson);
    } catch (err) {
      this.logger.warn('jsonToText' + err?.['message']);
    }

    let page: Page = null;
    const dirtyActors = this.dirtyActors(documentName);
    if (dirtyActors.length === 0) return;
    try {
      await this.requireActors(pageId, dirtyActors);
    } catch (error) {
      // The in-memory Ydoc may already contain a revoked actor's update. Close
      // every peer now, then evict after Hocuspocus releases saveMutex so the
      // next connection reloads canonical DB state.
      data.instance.closeConnections(documentName);
      this.evictWhenIdle(data.instance, data.document);
      throw error;
    }
    const editingUserIds = dirtyActors.map((actor) => actor.userId);

    try {
      await executeTx(this.db, async (trx) => {
        page = await this.pageRepo.findById(pageId, {
          withLock: true,
          includeContent: true,
          trx,
        });

        if (!page) {
          this.logger.error(`Page with id ${pageId} not found`);
          return;
        }

        if (isDeepStrictEqual(tiptapJson, page.content)) {
          page = null;
          return;
        }

        let contributorIds = undefined;
        try {
          const existingContributors = page.contributorIds || [];
          contributorIds = Array.from(
            new Set([
              ...existingContributors,
              ...editingUserIds,
              page.creatorId,
            ]),
          );
        } catch (err) {
          //this.logger.debug('Contributors error:' + err?.['message']);
        }

        await this.pageRepo.updatePage(
          {
            content: tiptapJson,
            textContent: textContent,
            ydoc: ydocState,
            lastUpdatedById: dirtyActors[dirtyActors.length - 1].userId,
            contributorIds: contributorIds,
          },
          pageId,
          trx,
        );

        this.logger.debug(`Page updated: ${pageId} - SlugId: ${page.slugId}`);
      });
      this.consumeActors(documentName, dirtyActors);
    } catch (err) {
      this.logger.error(`Failed to update page ${pageId}`, err);
      throw err;
    }

    if (page) {
      document.broadcastStateless(
        JSON.stringify({
          type: 'page.updated',
          updatedAt: new Date().toISOString(),
          lastUpdatedById: lastContext?.user?.id,
          lastUpdatedBy: lastContext?.user
            ? {
                id: lastContext.user?.id,
                name: lastContext.user?.name,
                avatarUrl: lastContext.user?.avatarUrl,
              }
            : undefined,
        }),
      );

      await this.syncTransclusion(pageId, page.workspaceId, tiptapJson);
    }

    if (page) {
      await this.collabHistory.addContributors(pageId, editingUserIds);

      const mentions = extractMentions(tiptapJson);

      const userMentions = extractUserMentions(mentions);
      const oldMentions = page.content ? extractMentions(page.content) : [];
      const oldMentionedUserIds = extractUserMentions(oldMentions).map(
        (m) => m.entityId,
      );

      if (userMentions.length > 0) {
        await this.notificationQueue.add(QueueJob.PAGE_MENTION_NOTIFICATION, {
          userMentions: userMentions.map((m) => ({
            userId: m.entityId,
            mentionId: m.id,
            creatorId: m.creatorId,
          })),
          oldMentionedUserIds,
          pageId,
          spaceId: page.spaceId,
          workspaceId: page.workspaceId,
        } as IPageMentionNotificationJob);
      }

      await this.enqueuePageHistory(
        page,
        dirtyActors[dirtyActors.length - 1].userId,
      );
    }
  }

  async onChange(data: onChangePayload<LecCollabContext>) {
    const { documentName, context } = data;
    if (!context?.user?.id) return;
    const epoch = (this.epochs.get(documentName) ?? 0) + 1;
    this.epochs.set(documentName, epoch);
    const actors = this.contributors.get(documentName) ?? new Map();
    const prior = actors.get(context.user.id);
    actors.set(context.user.id, {
      userId: context.user.id,
      capability:
        prior?.epoch === epoch - 1 && prior.capability === 'EDIT'
          ? 'EDIT'
          : context.writeCapability,
      epoch,
    });
    this.contributors.set(documentName, actors);
  }

  async afterUnloadDocument(data: afterUnloadDocumentPayload) {
    const documentName = data.documentName;
    this.contributors.delete(documentName);
    this.epochs.delete(documentName);
  }

  private dirtyActors(documentName: string): DirtyActor[] {
    return [...(this.contributors.get(documentName)?.values() ?? [])];
  }

  private consumeActors(documentName: string, stored: DirtyActor[]) {
    const current = this.contributors.get(documentName);
    if (!current) return;
    for (const actor of stored) {
      if (current.get(actor.userId)?.epoch === actor.epoch)
        current.delete(actor.userId);
    }
    if (current.size === 0) this.contributors.delete(documentName);
  }

  private evictWhenIdle(instance: Hocuspocus, document: Document) {
    if (instance.shouldUnloadDocument(document)) {
      void instance.unloadDocument(document);
      return;
    }
    setImmediate(() => this.evictWhenIdle(instance, document));
  }

  private async requireActors(pageId: string, actors: DirtyActor[]) {
    const page = await this.pageRepo.findById(pageId);
    if (!page) throw new Error('Page not found');
    for (const actor of actors) {
      const user = await this.users.findById(actor.userId, page.workspaceId);
      if (!user) throw new Error('Editing user unavailable');
      await this.authorization.requirePage(page, user, actor.capability);
    }
  }

  private async enqueuePageHistory(page: Page, actorId: string): Promise<void> {
    const pageAge = Date.now() - new Date(page.createdAt).getTime();
    const delay =
      pageAge < HISTORY_FAST_THRESHOLD
        ? HISTORY_FAST_INTERVAL
        : HISTORY_INTERVAL;

    await this.historyQueue.add(
      QueueJob.PAGE_HISTORY,
      { pageId: page.id, actorId } as IPageHistoryJob,
      { jobId: page.id, delay },
    );
  }

  /**
   * Refresh `page_transclusions` and `page_transclusion_references` to match
   * the page's current content. Runs outside the page-write transaction and
   * isolates each call so a failure here cannot affect the page save itself.
   * The diff is idempotent — the next save converges if a round drops anything.
   */
  private async syncTransclusion(
    pageId: string,
    workspaceId: string,
    tiptapJson: unknown,
  ): Promise<void> {
    try {
      await this.transclusionService.syncPageTransclusions(
        pageId,
        workspaceId,
        tiptapJson,
      );
    } catch (err) {
      this.logger.error(
        { err, pageId },
        'Failed to sync transclusions for page',
      );
    }
    try {
      await this.transclusionService.syncPageReferences(
        pageId,
        workspaceId,
        tiptapJson,
      );
    } catch (err) {
      this.logger.error(
        { err, pageId },
        'Failed to sync transclusion references for page',
      );
    }
  }
}
