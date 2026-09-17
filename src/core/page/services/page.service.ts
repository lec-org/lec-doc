import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreatePageDto, ContentFormat } from '../dto/create-page.dto';
import { ContentOperation, UpdatePageDto } from '../dto/update-page.dto';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { InsertablePage, Page, User } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { CursorPaginationResult } from '@docmost/db/pagination/cursor-pagination';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { MovePageDto } from '../dto/move-page.dto';
import { generateSlugId } from '../../../common/helpers';
import { getPageTitle } from '../../../common/helpers';
import { dbOrTx, executeTx } from '@docmost/db/utils';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { v7 as uuid7 } from 'uuid';
import {
  createYdocFromJson,
  getAttachmentIds,
  getProsemirrorContent,
  isAttachmentNode,
  removeMarkTypeFromDoc,
} from '../../../common/helpers/prosemirror/utils';
import {
  htmlToJson,
  jsonToNode,
  jsonToText,
} from 'src/collaboration/collaboration.util';
import {
  CopyPageMapEntry,
  ICopyPageAttachment,
} from '../dto/duplicate-page.dto';
import { Node as PMNode } from '@tiptap/pm/model';
import { StorageService } from '../../../integrations/storage/storage.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { CollaborationGateway } from '../../../collaboration/collaboration.gateway';
import {
  INTERNAL_LINK_REGEX,
  extractPageSlugId,
} from '../../../integrations/export/utils';
import { markdownToHtml } from '@lec/doc-editor';
import { WatcherService } from '../../watcher/watcher.service';
import { sql } from 'kysely';
import { TransclusionService } from '../transclusion/transclusion.service';
import { LecResourceLifecycleService } from '../../lec-authorization/lec-resource-lifecycle.service';
import { LecAuthorizationService } from '../../lec-authorization/lec-authorization.service';
import {
  LecCapability,
  LecPrincipal,
} from '../../lec-authorization/lec-policy.types';
import { PageMaintenanceService } from './page-maintenance.service';

@Injectable()
export class PageService {
  private readonly logger = new Logger(PageService.name);

  constructor(
    private pageRepo: PageRepo,
    private pagePermissionRepo: PagePermissionRepo,
    private attachmentRepo: AttachmentRepo,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly storageService: StorageService,
    @InjectQueue(QueueName.ATTACHMENT_QUEUE) private attachmentQueue: Queue,
    @InjectQueue(QueueName.GENERAL_QUEUE) private generalQueue: Queue,
    private collaborationGateway: CollaborationGateway,
    private readonly watcherService: WatcherService,
    private readonly transclusionService: TransclusionService,
    private readonly lifecycle: LecResourceLifecycleService,
    private readonly lecAuthorization: LecAuthorizationService,
    private readonly maintenance: PageMaintenanceService,
  ) {}

  async findById(
    pageId: string,
    includeContent?: boolean,
    includeYdoc?: boolean,
    includeSpace?: boolean,
  ): Promise<Page> {
    return this.pageRepo.findById(pageId, {
      includeContent,
      includeYdoc,
      includeSpace,
    });
  }

  async create(
    user: User,
    principal: Extract<LecPrincipal, { type: 'OIDC' }>,
    createPageDto: CreatePageDto,
    isBase: boolean = false,
  ): Promise<Page> {
    const userId = user.id;
    const workspaceId = user.workspaceId;
    let parentPageId = undefined;

    // check if parent page exists
    if (createPageDto.parentPageId) {
      const parentPage = await this.pageRepo.findById(
        createPageDto.parentPageId,
      );

      if (
        !parentPage ||
        parentPage.deletedAt ||
        parentPage.spaceId !== createPageDto.spaceId
      ) {
        throw new NotFoundException('Parent page not found');
      }

      parentPageId = parentPage.id;
    }

    let content = undefined;
    let textContent = undefined;
    let ydoc = undefined;

    if (createPageDto?.content && createPageDto?.format) {
      const prosemirrorJson = await this.parseProsemirrorContent(
        createPageDto.content,
        createPageDto.format,
      );

      content = prosemirrorJson;
      textContent = jsonToText(prosemirrorJson);
      ydoc = createYdocFromJson(prosemirrorJson);
    }

    const pageId = uuid7();
    const page = await this.lifecycle.createPage(
      user,
      principal,
      pageId,
      parentPageId ? 'DOCMOST_PAGE' : 'DOCMOST_SPACE',
      parentPageId ?? createPageDto.spaceId,
      async (trx) => {
        const inserted = await this.pageRepo.insertPage(
          {
            id: pageId,
            slugId: generateSlugId(),
            title: createPageDto.title,
            position: await this.nextPagePosition(
              createPageDto.spaceId,
              parentPageId,
              trx,
            ),
            icon: createPageDto.icon,
            parentPageId,
            spaceId: createPageDto.spaceId,
            creatorId: userId,
            workspaceId,
            lastUpdatedById: userId,
            isBase,
            content,
            textContent,
            ydoc,
          },
          trx,
          false,
        );
        await this.watcherService.addPageWatchers(
          [userId],
          inserted.id,
          createPageDto.spaceId,
          workspaceId,
          trx,
        );
        return inserted;
      },
    );
    return page;
  }

  nextPagePosition(
    spaceId: string,
    parentPageId?: string,
    trx?: KyselyTransaction,
  ) {
    return this.maintenance.nextPagePosition(spaceId, parentPageId, trx);
  }

  async update(
    page: Page,
    updatePageDto: UpdatePageDto,
    user: User,
  ): Promise<Page> {
    const contributors = new Set<string>(page.contributorIds);
    contributors.add(user.id);
    const contributorIds = Array.from(contributors);

    await this.pageRepo.updatePage(
      {
        title: updatePageDto.title,
        icon: updatePageDto.icon,
        lastUpdatedById: user.id,
        updatedAt: new Date(),
        contributorIds: contributorIds,
      },
      page.id,
    );

    this.generalQueue
      .add(QueueJob.ADD_PAGE_WATCHERS, {
        actorId: user.id,
        userIds: [user.id],
        pageId: page.id,
        spaceId: page.spaceId,
        workspaceId: page.workspaceId,
      })
      .catch((err) =>
        this.logger.warn(`Failed to queue add-page-watchers: ${err.message}`),
      );

    if (
      updatePageDto.content &&
      updatePageDto.operation &&
      updatePageDto.format
    ) {
      await this.updatePageContent(
        page.id,
        updatePageDto.content,
        updatePageDto.operation,
        updatePageDto.format,
        user,
      );
    }

    return await this.pageRepo.findById(page.id, {
      includeSpace: true,
      includeContent: true,
      includeCreator: true,
      includeLastUpdatedBy: true,
      includeContributors: true,
    });
  }

  async updatePageContent(
    pageId: string,
    content: string | object,
    operation: ContentOperation,
    format: ContentFormat,
    user: User,
  ): Promise<void> {
    const prosemirrorJson = await this.parseProsemirrorContent(content, format);

    const documentName = `page.${pageId}`;
    await this.collaborationGateway.handleYjsEvent(
      'updatePageContent',
      documentName,
      { operation, prosemirrorJson, user },
    );
  }

  async getSidebarPages(
    spaceId: string,
    pagination: PaginationOptions,
    pageId?: string,
    user?: User,
    spaceCanEdit?: boolean,
  ): Promise<CursorPaginationResult<Partial<Page> & { hasChildren: boolean }>> {
    if (!user) {
      return this.pageRepo.findSidebarCandidates(
        spaceId,
        pageId,
        pagination,
      ) as any;
    }

    const limit = pagination.limit;
    const backwards = Boolean(pagination.beforeCursor && !pagination.cursor);
    const hasRestrictions =
      await this.pagePermissionRepo.hasRestrictedPagesInSpace(spaceId);
    const canEdit = new Map<string, boolean>();
    let cursor = pagination.cursor;
    let beforeCursor = pagination.beforeCursor;
    let exhausted = false;
    let lastScannedCursor: string | undefined;
    let authorized: Array<
      Pick<Page, 'id' | 'workspaceId'> & { $cursor: string }
    > = [];

    for (;;) {
      const batch = await this.pageRepo.findSidebarCandidates(spaceId, pageId, {
        limit: 100,
        cursor,
        beforeCursor,
      } as PaginationOptions);
      const candidates = batch.items;
      if (candidates.length === 0) {
        exhausted = true;
        break;
      }

      const coreAllowed = await this.lecAuthorization.filterPages(
        candidates,
        user,
      );
      let allowed = coreAllowed;
      if (hasRestrictions && coreAllowed.length > 0) {
        const accessible =
          await this.pagePermissionRepo.filterAccessiblePageIdsWithPermissions(
            coreAllowed.map((candidate) => candidate.id),
            user.id,
          );
        const accessibleById = new Map(
          accessible.map((candidate) => [candidate.id, candidate.canEdit]),
        );
        allowed = coreAllowed.filter((candidate) =>
          accessibleById.has(candidate.id),
        );
        accessibleById.forEach((value, id) => canEdit.set(id, value));
      } else {
        coreAllowed.forEach((candidate) => canEdit.set(candidate.id, true));
      }
      authorized = backwards
        ? [...allowed, ...authorized]
        : [...authorized, ...allowed];

      if (backwards) {
        lastScannedCursor = candidates[0].$cursor;
        beforeCursor = lastScannedCursor;
        exhausted = !batch.meta.hasNextPage;
      } else {
        lastScannedCursor = candidates[candidates.length - 1].$cursor;
        cursor = batch.meta.nextCursor ?? undefined;
        exhausted = !cursor;
      }
      if (authorized.length >= limit || exhausted) break;
    }

    const selected = backwards
      ? authorized.slice(-limit)
      : authorized.slice(0, limit);
    const selectedIds = selected.map((candidate) => candidate.id);
    const content = await this.pageRepo.findSidebarContentByIds(selectedIds);
    const byId = new Map(content.map((page) => [page.id, page]));
    const items = selectedIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((page: any) => ({
        ...page,
        canEdit: canEdit.get(page.id) && (spaceCanEdit ?? true),
      }));

    const parentIds = items
      .filter((page) => page.hasChildren)
      .map((page) => page.id);
    if (parentIds.length > 0) {
      let children = await this.pageRepo.findChildPageCandidates(parentIds);
      children = await this.lecAuthorization.filterPages(children, user);
      if (hasRestrictions && children.length > 0) {
        const accessibleChildren =
          await this.pagePermissionRepo.filterAccessiblePageIds({
            pageIds: children.map((child) => child.id),
            userId: user.id,
          });
        const accessible = new Set(accessibleChildren);
        children = children.filter((child) => accessible.has(child.id));
      }
      const parentsWithChildren = new Set(
        children.map((child) => child.parentPageId),
      );
      items.forEach((page) => {
        page.hasChildren = parentsWithChildren.has(page.id);
      });
    }

    const hasMore = authorized.length > limit || !exhausted;
    const firstCursor = selected[0]?.$cursor ?? lastScannedCursor ?? null;
    const lastCursor =
      selected[selected.length - 1]?.$cursor ?? lastScannedCursor ?? null;
    return {
      items,
      meta: {
        limit,
        hasNextPage: backwards ? Boolean(pagination.beforeCursor) : hasMore,
        hasPrevPage: backwards ? hasMore : Boolean(pagination.cursor),
        nextCursor: backwards
          ? pagination.beforeCursor
            ? lastCursor
            : null
          : hasMore
            ? lastCursor
            : null,
        prevCursor: backwards
          ? hasMore
            ? firstCursor
            : null
          : pagination.cursor
            ? firstCursor
            : null,
      },
    };
  }

  async movePageToSpace(rootPage: Page, spaceId: string, userId: string) {
    return executeTx(this.db, async (trx) => {
      await this.pageRepo.lockPageHierarchySpaces(
        [rootPage.spaceId, spaceId],
        trx,
      );

      const currentRootPage = await this.pageRepo.findById(rootPage.id, {
        trx,
      });
      if (!currentRootPage || currentRootPage.deletedAt) {
        throw new NotFoundException('Page to move not found');
      }
      if (currentRootPage.spaceId !== rootPage.spaceId) {
        throw new ConflictException('Page location changed; retry the move');
      }

      const allPages = await this.pageRepo.getPageAndDescendants(
        currentRootPage.id,
        { includeContent: false, trx },
      );
      const accessiblePages = await this.filterAccessibleTreePages(
        allPages,
        currentRootPage.id,
        userId,
        currentRootPage.spaceId,
      );
      const accessibleIds = new Set(accessiblePages.map((p) => p.id));
      const pagesToOrphan = allPages.filter(
        (p) =>
          !accessibleIds.has(p.id) &&
          p.parentPageId &&
          accessibleIds.has(p.parentPageId),
      );

      // Orphan inaccessible child pages (make them root pages in original space)
      for (const page of pagesToOrphan) {
        const orphanPosition = await this.nextPagePosition(
          currentRootPage.spaceId,
          null,
          trx,
        );
        await this.pageRepo.updatePage(
          { parentPageId: null, position: orphanPosition },
          page.id,
          trx,
        );
      }

      // Update root page
      const nextPosition = await this.nextPagePosition(spaceId, null, trx);
      await this.pageRepo.updatePage(
        { spaceId, parentPageId: null, position: nextPosition },
        currentRootPage.id,
        trx,
      );

      const pageIdsToMove = accessiblePages.map((p) => p.id);

      const childPageIds = pageIdsToMove.filter(
        (id) => id !== currentRootPage.id,
      );

      if (pageIdsToMove.length > 1) {
        // Update sub pages (all accessible pages except root)
        await this.pageRepo.updatePages({ spaceId }, childPageIds, trx);
      }

      if (pageIdsToMove.length > 0) {
        await trx
          .updateTable('pageAccess')
          .set({ spaceId: spaceId })
          .where('pageId', 'in', pageIdsToMove)
          .execute();

        // update spaceId in shares
        await trx
          .updateTable('shares')
          .set({ spaceId: spaceId })
          .where('pageId', 'in', pageIdsToMove)
          .execute();

        // Update comments
        await trx
          .updateTable('comments')
          .set({ spaceId: spaceId })
          .where('pageId', 'in', pageIdsToMove)
          .execute();

        // Update page verifications
        await trx
          .updateTable('pageVerifications')
          .set({ spaceId: spaceId })
          .where('pageId', 'in', pageIdsToMove)
          .execute();

        // Update notifications — access follows the page after a move
        await trx
          .updateTable('notifications')
          .set({ spaceId: spaceId })
          .where('pageId', 'in', pageIdsToMove)
          .execute();

        // Update attachments
        await this.attachmentRepo.updateAttachmentsByPageId(
          { spaceId },
          pageIdsToMove,
          trx,
        );

        // Update watchers and remove those without access to new space
        await this.watcherService.movePageWatchersToSpace(
          pageIdsToMove,
          spaceId,
          {
            trx,
          },
        );
      }

      return { childPageIds };
    });
  }

  async duplicatePage(
    rootPage: Pick<
      Page,
      | 'id'
      | 'workspaceId'
      | 'spaceId'
      | 'parentPageId'
      | 'position'
      | 'deletedAt'
    >,
    targetSpaceId: string | undefined,
    authUser: User,
  ) {
    const spaceId = targetSpaceId || rootPage.spaceId;
    const isDuplicateInSameSpace =
      !targetSpaceId || targetSpaceId === rootPage.spaceId;

    const candidates = await this.pageRepo.findPageTreeCandidates(rootPage.id);
    const currentRoot = candidates.find((page) => page.id === rootPage.id);
    if (
      !currentRoot ||
      currentRoot.workspaceId !== rootPage.workspaceId ||
      currentRoot.spaceId !== rootPage.spaceId
    ) {
      throw new ConflictException('Page location changed; retry the copy');
    }

    // Core must authorize the complete source tree. Local ACL may only narrow
    // that authorized tree; it must never turn a Core denial into a partial copy.
    const coreAllowed = await this.lecAuthorization.filterPages(
      candidates,
      authUser,
      'VIEW',
    );
    const coreAllowedIds = new Set(coreAllowed.map((page) => page.id));
    if (candidates.some((page) => !coreAllowedIds.has(page.id))) {
      this.lecAuthorization.deny();
    }
    await this.lecAuthorization.requireSpace(
      spaceId,
      rootPage.workspaceId,
      authUser,
      'CREATE',
    );
    const principal = await this.lecAuthorization.principal(
      authUser,
      rootPage.workspaceId,
    );
    if (principal.type !== 'OIDC') this.lecAuthorization.deny();

    const accessibleCandidates = await this.filterAccessibleTreePages(
      candidates,
      rootPage.id,
      authUser.id,
      rootPage.spaceId,
    );
    if (!accessibleCandidates.some((page) => page.id === rootPage.id)) {
      this.lecAuthorization.deny();
    }

    const loadedPages = await this.pageRepo.findExportPagesByIds(
      accessibleCandidates.map((page) => page.id),
    );
    const loadedById = new Map(loadedPages.map((page) => [page.id, page]));
    const pages = accessibleCandidates.map((candidate) => {
      const page = loadedById.get(candidate.id);
      if (!page)
        throw new ConflictException('Page tree changed; retry the copy');
      return page;
    });

    const nextPosition = isDuplicateInSameSpace
      ? generateJitteredKeyBetween(rootPage.position, null)
      : await this.nextPagePosition(spaceId);

    const orderedPages: typeof pages = [];
    const remaining = new Map(pages.map((page) => [page.id, page]));
    while (remaining.size > 0) {
      let added = false;
      for (const page of remaining.values()) {
        if (
          page.id === rootPage.id ||
          orderedPages.some((parent) => parent.id === page.parentPageId)
        ) {
          orderedPages.push(page);
          remaining.delete(page.id);
          added = true;
        }
      }
      if (!added)
        throw new ConflictException('Page tree changed; retry the copy');
    }

    const pageMap = new Map<string, CopyPageMapEntry>();
    orderedPages.forEach((page) => {
      pageMap.set(page.id, {
        newPageId: uuid7(),
        newSlugId: generateSlugId(),
        oldSlugId: page.slugId,
      });
    });

    const slugIdMap = new Map<string, CopyPageMapEntry>();
    for (const [, entry] of pageMap) {
      slugIdMap.set(entry.oldSlugId, entry);
    }

    const attachmentMap = new Map<string, ICopyPageAttachment>();

    const insertablePages: InsertablePage[] = await Promise.all(
      orderedPages.map(async (page) => {
        const pageContent = getProsemirrorContent(page.content);
        const pageFromMap = pageMap.get(page.id);

        const doc = jsonToNode(pageContent);
        const prosemirrorDoc = removeMarkTypeFromDoc(doc, 'comment');

        const attachmentIds = getAttachmentIds(prosemirrorDoc.toJSON());

        if (attachmentIds.length > 0) {
          attachmentIds.forEach((attachmentId: string) => {
            const newPageId = pageFromMap.newPageId;
            const newAttachmentId = uuid7();
            attachmentMap.set(attachmentId, {
              newPageId: newPageId,
              oldPageId: page.id,
              oldAttachmentId: attachmentId,
              newAttachmentId: newAttachmentId,
            });

            prosemirrorDoc.descendants((node: PMNode) => {
              if (isAttachmentNode(node.type.name)) {
                if (node.attrs.attachmentId === attachmentId) {
                  //@ts-ignore
                  node.attrs.attachmentId = newAttachmentId;

                  if (node.attrs.src) {
                    //@ts-ignore
                    node.attrs.src = node.attrs.src.replace(
                      attachmentId,
                      newAttachmentId,
                    );
                  }
                  if (node.attrs.src) {
                    //@ts-ignore
                    node.attrs.src = node.attrs.src.replace(
                      attachmentId,
                      newAttachmentId,
                    );
                  }
                }
              }
            });
          });
        }

        // Update internal page links in mention nodes
        prosemirrorDoc.descendants((node: PMNode) => {
          if (
            node.type.name === 'mention' &&
            node.attrs.entityType === 'page'
          ) {
            const referencedPageId = node.attrs.entityId;

            // Check if the referenced page is within the pages being copied
            if (referencedPageId && pageMap.has(referencedPageId)) {
              const mappedPage = pageMap.get(referencedPageId);
              //@ts-ignore
              node.attrs.entityId = mappedPage.newPageId;
              //@ts-ignore
              node.attrs.slugId = mappedPage.newSlugId;
            }
          }

          // Remap transclusion-reference source pages to their copies when
          // the source page is also being duplicated in the same operation.
          if (node.type.name === 'transclusionReference') {
            const sourcePageId = node.attrs.sourcePageId;
            if (sourcePageId && pageMap.has(sourcePageId)) {
              const mappedPage = pageMap.get(sourcePageId);
              //@ts-ignore
              node.attrs.sourcePageId = mappedPage.newPageId;
            }
          }

          // Update internal page links in link marks
          for (const mark of node.marks) {
            if (
              mark.type.name === 'link' &&
              mark.attrs.internal &&
              mark.attrs.href
            ) {
              const match = mark.attrs.href.match(INTERNAL_LINK_REGEX);
              if (match) {
                const slugId = extractPageSlugId(match[5]);
                if (slugId && slugIdMap.has(slugId)) {
                  const mappedPage = slugIdMap.get(slugId);
                  //@ts-ignore
                  mark.attrs.href = mark.attrs.href.replace(
                    slugId,
                    mappedPage.newSlugId,
                  );
                }
              }
            }
          }
        });

        const prosemirrorJson = prosemirrorDoc.toJSON();

        // Add "Copy of " prefix to the root page title only for duplicates in same space
        let title = page.title;
        if (isDuplicateInSameSpace && page.id === rootPage.id) {
          const originalTitle = getPageTitle(page.title);
          title = `Copy of ${originalTitle}`;
        }

        return {
          id: pageFromMap.newPageId,
          slugId: pageFromMap.newSlugId,
          title: title,
          icon: page.icon,
          content: prosemirrorJson,
          textContent: jsonToText(prosemirrorJson),
          ydoc: createYdocFromJson(prosemirrorJson),
          position: page.id === rootPage.id ? nextPosition : page.position,
          spaceId: spaceId,
          workspaceId: page.workspaceId,
          creatorId: authUser.id,
          lastUpdatedById: authUser.id,
          parentPageId:
            page.id === rootPage.id
              ? isDuplicateInSameSpace
                ? rootPage.parentPageId
                : null
              : page.parentPageId
                ? pageMap.get(page.parentPageId)?.newPageId
                : null,
        };
      }),
    );

    for (const page of insertablePages) {
      const isRoot = page.id === pageMap.get(rootPage.id).newPageId;
      await this.lifecycle.createPage(
        authUser,
        principal,
        page.id,
        isRoot && !page.parentPageId ? 'DOCMOST_SPACE' : 'DOCMOST_PAGE',
        isRoot && !page.parentPageId ? spaceId : page.parentPageId!,
        (trx) => this.pageRepo.insertPage(page, trx, false),
      );
    }

    // Brand-new pages have no prior transclusion rows, so bulk extraction is
    // safe after every page has completed its lifecycle.
    try {
      await this.transclusionService.insertTransclusionsForPages(
        insertablePages.map((p) => ({
          id: p.id,
          workspaceId: p.workspaceId,
          content: p.content,
        })),
      );
    } catch (err) {
      this.logger.error(
        'Failed to insert transclusions for duplicated pages',
        err,
      );
    }

    try {
      await this.transclusionService.insertReferencesForPages(
        insertablePages.map((p) => ({
          id: p.id,
          workspaceId: p.workspaceId,
          content: p.content,
        })),
      );
    } catch (err) {
      this.logger.error(
        'Failed to insert transclusion references for duplicated pages',
        err,
      );
    }

    const insertedPageIds = insertablePages.map((page) => page.id);

    //TODO: best to handle this in a queue
    const attachmentsIds = Array.from(attachmentMap.keys());
    if (attachmentsIds.length > 0) {
      const attachments = await this.db
        .selectFrom('attachments')
        .selectAll()
        .where('id', 'in', attachmentsIds)
        .where('workspaceId', '=', rootPage.workspaceId)
        .execute();

      for (const attachment of attachments) {
        const pageAttachment = attachmentMap.get(attachment.id);

        // make sure the copied attachment belongs to the page it was copied from
        if (!pageAttachment || attachment.pageId !== pageAttachment.oldPageId) {
          continue;
        }

        const newAttachmentId = pageAttachment.newAttachmentId;
        const newPageId = pageAttachment.newPageId;
        const sourcePage = {
          id: pageAttachment.oldPageId,
          workspaceId: rootPage.workspaceId,
          deletedAt: null,
        };
        const targetPage = {
          id: newPageId,
          workspaceId: rootPage.workspaceId,
          deletedAt: null,
        };
        const newPathFile = attachment.filePath.replace(
          attachment.id,
          newAttachmentId,
        );

        await this.lecAuthorization.requirePage(sourcePage, authUser, 'VIEW');
        await this.lecAuthorization.requirePage(targetPage, authUser, 'EDIT');
        await this.storageService.copy(attachment.filePath, newPathFile);

        await this.lecAuthorization.requirePage(sourcePage, authUser, 'VIEW');
        await this.lecAuthorization.requirePage(targetPage, authUser, 'EDIT');
        await this.db
          .insertInto('attachments')
          .values({
            id: newAttachmentId,
            type: attachment.type,
            filePath: newPathFile,
            fileName: attachment.fileName,
            fileSize: attachment.fileSize,
            mimeType: attachment.mimeType,
            fileExt: attachment.fileExt,
            creatorId: attachment.creatorId,
            workspaceId: attachment.workspaceId,
            pageId: newPageId,
            spaceId: spaceId,
          })
          .execute();
      }
    }

    const newPageId = pageMap.get(rootPage.id).newPageId;
    const duplicatedPage = await this.pageRepo.findById(newPageId, {
      includeSpace: true,
    });

    const hasChildren = orderedPages.length > 1;
    const childPageIds = insertedPageIds.filter((id) => id !== newPageId);

    return {
      ...duplicatedPage,
      hasChildren,
      childPageIds,
    };
  }

  async movePage(
    dto: MovePageDto,
    movedPage: Page,
    existingTrx?: KyselyTransaction,
  ) {
    // validate position value by attempting to generate a key
    try {
      generateJitteredKeyBetween(dto.position, null);
    } catch (err) {
      throw new BadRequestException('Invalid move position');
    }

    if (dto.parentPageId && dto.parentPageId === dto.pageId) {
      throw new BadRequestException('A page cannot be its own parent');
    }

    await executeTx(
      this.db,
      async (trx) => {
        await this.pageRepo.lockPageHierarchySpaces([movedPage.spaceId], trx);

        const currentPage = await this.pageRepo.findById(dto.pageId, { trx });
        if (!currentPage || currentPage.deletedAt) {
          throw new NotFoundException('Moved page not found');
        }
        if (currentPage.spaceId !== movedPage.spaceId) {
          throw new ConflictException('Page location changed; retry the move');
        }

        let parentPageId = null;
        if (currentPage.parentPageId === dto.parentPageId) {
          parentPageId = undefined;
        } else {
          if (dto.parentPageId) {
            const parentPage = await this.pageRepo.findById(dto.parentPageId, {
              trx,
            });
            if (
              !parentPage ||
              parentPage.deletedAt ||
              parentPage.spaceId !== currentPage.spaceId
            ) {
              throw new NotFoundException('Parent page not found');
            }
            if (
              await this.pageRepo.isPageDescendant(
                dto.pageId,
                parentPage.id,
                trx,
              )
            ) {
              throw new BadRequestException(
                'A page cannot be moved under its descendant',
              );
            }
            parentPageId = parentPage.id;
          }
        }

        await this.pageRepo.updatePage(
          {
            position: dto.position,
            parentPageId: parentPageId,
          },
          dto.pageId,
          trx,
        );
      },
      existingTrx,
    );
  }

  async getPageBreadCrumbs(childPageId: string) {
    const ancestors = await this.db
      .withRecursive('page_ancestors', (db) =>
        db
          .selectFrom('pages')
          .select([
            'id',
            'slugId',
            'title',
            'icon',
            'isBase',
            'position',
            'parentPageId',
            'spaceId',
            'workspaceId',
            'deletedAt',
          ])
          .where('id', '=', childPageId)
          .where('deletedAt', 'is', null)
          .unionAll((exp) =>
            exp
              .selectFrom('pages as p')
              .select([
                'p.id',
                'p.slugId',
                'p.title',
                'p.icon',
                'p.isBase',
                'p.position',
                'p.parentPageId',
                'p.spaceId',
                'p.workspaceId',
                'p.deletedAt',
              ])
              .innerJoin('page_ancestors as pa', 'pa.parentPageId', 'p.id')
              .where('p.deletedAt', 'is', null),
          ),
      )
      .selectFrom('page_ancestors')
      .selectAll('page_ancestors')
      .select((eb) =>
        eb
          .exists(
            eb
              .selectFrom('pages as child')
              .select(sql`1`.as('one'))
              .whereRef('child.parentPageId', '=', 'page_ancestors.id')
              .where('child.deletedAt', 'is', null),
          )
          .as('hasChildren'),
      )
      .execute();

    return ancestors.reverse();
  }

  async getRecentSpacePages(
    spaceId: string,
    user: User,
    pagination: PaginationOptions,
  ): Promise<CursorPaginationResult<Page>> {
    return this.getAuthorizedPageList({ spaceId }, user, pagination);
  }

  async getRecentPages(
    user: User,
    pagination: PaginationOptions,
  ): Promise<CursorPaginationResult<Page>> {
    return this.getAuthorizedPageList({ userId: user.id }, user, pagination);
  }

  async getCreatedByPages(
    creatorId: string,
    requestingUser: User,
    pagination: PaginationOptions,
    spaceId?: string,
  ): Promise<CursorPaginationResult<Page>> {
    return this.getAuthorizedPageList(
      { creatorId, userId: requestingUser.id, spaceId },
      requestingUser,
      pagination,
    );
  }

  async getDeletedSpacePages(
    spaceId: string,
    user: User,
    pagination: PaginationOptions,
  ): Promise<CursorPaginationResult<Page>> {
    return this.getAuthorizedPageList(
      { spaceId, deleted: true },
      user,
      pagination,
      'RESTORE',
    );
  }

  private async getAuthorizedPageList(
    opts: {
      spaceId?: string;
      userId?: string;
      creatorId?: string;
      deleted?: boolean;
    },
    user: User,
    pagination: PaginationOptions,
    capability: LecCapability = 'VIEW',
  ): Promise<CursorPaginationResult<Page>> {
    const limit = pagination.limit;
    const backwards = Boolean(pagination.beforeCursor && !pagination.cursor);
    let cursor = pagination.cursor;
    let beforeCursor = pagination.beforeCursor;
    let exhausted = false;
    let authorized: Array<
      Pick<Page, 'id' | 'workspaceId'> & { $cursor: string }
    > = [];

    for (;;) {
      const batch = await this.pageRepo.findPageListCandidates(opts, {
        limit: 100,
        cursor,
        beforeCursor,
      } as PaginationOptions);
      const candidates = batch.items;
      if (candidates.length === 0) {
        exhausted = true;
        break;
      }
      const coreAllowed = await this.lecAuthorization.filterPages(
        candidates,
        user,
        capability,
      );
      const locallyAllowed =
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds: coreAllowed.map((page) => page.id),
          userId: user.id,
          spaceId: opts.spaceId,
        });
      const allowed = new Set(locallyAllowed);
      const accepted = coreAllowed.filter((page) => allowed.has(page.id));
      authorized = backwards
        ? [...accepted, ...authorized]
        : [...authorized, ...accepted];
      if (authorized.length > limit) break;

      if (backwards) {
        beforeCursor = candidates[0].$cursor;
        if (candidates.length < 100) exhausted = true;
      } else {
        cursor = batch.meta.nextCursor;
        if (!cursor) exhausted = true;
      }
      if (exhausted) break;
    }

    const selected = backwards
      ? authorized.slice(-limit)
      : authorized.slice(0, limit);
    const pageIds = selected.map((page) => page.id);
    const content = await this.pageRepo.findPageListContentByIds(
      pageIds,
      Boolean(opts.deleted),
    );
    const byId = new Map(content.map((page) => [page.id, page]));
    const items = pageIds.map((id) => byId.get(id)).filter(Boolean) as Page[];
    const hasMore = authorized.length > limit || !exhausted;

    return {
      items,
      meta: {
        limit,
        hasNextPage: backwards ? Boolean(pagination.beforeCursor) : hasMore,
        hasPrevPage: backwards ? hasMore : Boolean(pagination.cursor),
        nextCursor:
          (backwards ? Boolean(pagination.beforeCursor) : hasMore) &&
          selected.length
            ? selected[selected.length - 1].$cursor
            : null,
        prevCursor:
          (backwards ? hasMore : Boolean(pagination.cursor)) && selected.length
            ? selected[0].$cursor
            : null,
      },
    };
  }

  forceDelete(pageId: string, workspaceId: string): Promise<void> {
    return this.maintenance.forceDelete(pageId, workspaceId);
  }

  private async parseProsemirrorContent(
    content: string | object,
    format: ContentFormat,
  ): Promise<any> {
    let prosemirrorJson: any;

    switch (format) {
      case 'markdown': {
        const html = await markdownToHtml(content as string);
        prosemirrorJson = htmlToJson(html as string);
        break;
      }
      case 'html': {
        prosemirrorJson = htmlToJson(content as string);
        break;
      }
      case 'json':
      default: {
        prosemirrorJson = content;
        break;
      }
    }

    try {
      jsonToNode(prosemirrorJson);
    } catch (err) {
      throw new BadRequestException('Invalid content format');
    }

    return prosemirrorJson;
  }

  /**
   * Filters a list of pages to only those accessible to the user while maintaining tree integrity.
   * A page is included only if:
   * 1. The user has access to it
   * 2. Its parent is also included (or it's the root page)
   * This ensures that if a middle page is inaccessible, its entire subtree is excluded.
   */
  private async filterAccessibleTreePages<
    T extends { id: string; parentPageId: string | null },
  >(
    pages: T[],
    rootPageId: string,
    userId: string,
    spaceId?: string,
  ): Promise<T[]> {
    if (pages.length === 0) return [];

    const pageIds = pages.map((p) => p.id);
    const accessibleIds = await this.pagePermissionRepo.filterAccessiblePageIds(
      {
        pageIds,
        userId,
        spaceId,
      },
    );
    const accessibleSet = new Set(accessibleIds);

    // Prune: include a page only if it's accessible AND its parent chain to root is included
    const includedIds = new Set<string>();

    // Process pages in a way that ensures parents are processed before children
    // We do this by iterating until no more pages can be added
    let changed = true;
    while (changed) {
      changed = false;
      for (const page of pages) {
        if (includedIds.has(page.id)) continue;
        if (!accessibleSet.has(page.id)) continue;

        // Root page: include if accessible
        if (page.id === rootPageId) {
          includedIds.add(page.id);
          changed = true;
          continue;
        }

        // Non-root: include if parent is already included
        if (page.parentPageId && includedIds.has(page.parentPageId)) {
          includedIds.add(page.id);
          changed = true;
        }
      }
    }

    return pages.filter((p) => includedIds.has(p.id));
  }
}
