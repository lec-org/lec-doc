import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  connectedPayload,
  Connection,
  Extension,
  Hocuspocus,
  onDisconnectPayload,
} from '@hocuspocus/server';
import { LecCollabContext } from './extensions/authentication.extension';
import { LecAuthorizationService } from '../core/lec-authorization/lec-authorization.service';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { z } from 'zod';

export const REVOCATION_CHANNEL = 'lec:doc:authorization:revocations';

const revocationSchema = z.strictObject({
  event_id: z.uuid(),
  workspace_id: z.uuid(),
  resource_kind: z.enum(['DOCMOST_SPACE', 'DOCMOST_PAGE']),
  resource_id: z.uuid(),
  resource_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type RevocationEvent = z.infer<typeof revocationSchema>;

type Active = {
  key: string;
  documentName: string;
  pageId: string;
  workspaceId: string;
  spaceId: string;
  context: LecCollabContext;
  connection: Connection<LecCollabContext>;
  instance: Hocuspocus;
};

@Injectable()
export class CollaborationConnectionRegistry
  implements Extension<LecCollabContext>, OnModuleDestroy
{
  private readonly logger = new Logger(CollaborationConnectionRegistry.name);
  private readonly active = new Map<string, Active>();
  private readonly resourceVersions = new Map<string, number>();
  private checking = false;
  private readonly timer = setInterval(() => void this.sweep(), 12_000);
  private readonly subscriber;

  constructor(
    private readonly authorization: LecAuthorizationService,
    private readonly pages: PageRepo,
    private readonly users: UserRepo,
    redis: RedisService,
  ) {
    this.timer.unref();
    this.subscriber = redis.getOrThrow().duplicate();
    this.subscriber.on('message', (_channel, payload) =>
      this.handleRevocation(payload),
    );
    void this.subscriber.subscribe(REVOCATION_CHANNEL);
  }

  async connected(data: connectedPayload<LecCollabContext>) {
    if (!data.context?.user) return;
    const key = this.key(data.socketId, data.documentName);
    this.active.set(key, {
      key,
      documentName: data.documentName,
      pageId: data.context.pageId,
      workspaceId: data.context.workspaceId,
      spaceId: data.context.spaceId,
      context: data.context,
      connection: data.connection,
      instance: data.instance,
    });
  }

  async onDisconnect(data: onDisconnectPayload<LecCollabContext>) {
    this.active.delete(this.key(data.socketId, data.documentName));
  }

  disconnectPage(pageId: string, workspaceId?: string) {
    this.disconnect(
      (entry) =>
        entry.pageId === pageId &&
        (!workspaceId || entry.workspaceId === workspaceId),
      true,
    );
  }

  disconnectSpace(spaceId: string, workspaceId?: string) {
    this.disconnect(
      (entry) =>
        entry.spaceId === spaceId &&
        (!workspaceId || entry.workspaceId === workspaceId),
      true,
    );
  }

  disconnectWorkspace(workspaceId: string) {
    this.disconnect((entry) => entry.workspaceId === workspaceId, true);
  }

  async sweep() {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const entry of [...this.active.values()]) {
        try {
          const page = await this.pages.findById(entry.pageId);
          const user = page
            ? await this.users.findById(entry.context.user.id, page.workspaceId)
            : null;
          if (!page || !user) throw new Error('principal unavailable');
          await this.authorization.requirePage(page, user, 'VIEW');
          if (!entry.connection.readOnly)
            await this.authorization.requirePage(page, user, 'EDIT');
        } catch {
          this.close(entry);
        }
      }
    } finally {
      this.checking = false;
    }
  }

  onModuleDestroy() {
    clearInterval(this.timer);
    void this.subscriber.quit();
    for (const entry of this.active.values()) this.close(entry);
  }

  private handleRevocation(payload: string) {
    const parsed = revocationSchema.safeParse(this.parse(payload));
    if (!parsed.success) {
      this.logger.error('Ignored invalid Core revocation publication');
      return;
    }
    const event = parsed.data;
    const resourceKey = `${event.workspace_id}\0${event.resource_kind}\0${event.resource_id}`;
    const latestVersion = this.resourceVersions.get(resourceKey) ?? 0;
    if (event.resource_version <= latestVersion) return;
    this.resourceVersions.set(resourceKey, event.resource_version);
    if (event.resource_kind === 'DOCMOST_PAGE')
      this.disconnectPage(event.resource_id, event.workspace_id);
    else this.disconnectSpace(event.resource_id, event.workspace_id);
  }

  private parse(payload: string) {
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }

  private disconnect(matches: (entry: Active) => boolean, evict = false) {
    const matched = [...this.active.values()].filter(matches);
    for (const entry of matched) this.close(entry);
    if (evict) {
      const documents = new Map(
        matched.map((entry) => [
          entry.documentName,
          { instance: entry.instance, document: entry.connection.document },
        ]),
      );
      for (const value of documents.values())
        this.evictWhenIdle(value.instance, value.document);
    }
  }

  private evictWhenIdle(instance: Hocuspocus, document: Connection['document']) {
    if (instance.shouldUnloadDocument(document)) {
      void instance.unloadDocument(document);
      return;
    }
    setImmediate(() => this.evictWhenIdle(instance, document));
  }

  private close(entry: Active) {
    this.active.delete(entry.key);
    entry.connection.close({ code: 4403, reason: 'authorization_revoked' });
  }

  private key(socketId: string, documentName: string) {
    return `${socketId}\0${documentName}`;
  }
}
