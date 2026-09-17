import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { NotificationRepo } from '@docmost/db/repos/notification/notification.repo';
import { InsertableNotification } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { WsGateway } from '../../ws/ws.gateway';
import { MailService } from '../../integrations/mail/mail.service';
import {
  NotificationTab,
  NotificationType,
  NotificationTypeToSettingKey,
} from './notification.constants';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { LecAuthorizationService } from '../lec-authorization/lec-authorization.service';
import { CursorPaginationResult } from '@docmost/db/pagination/cursor-pagination';
import { Notification, User } from '@docmost/db/types/entity.types';
import { dbOrTx } from '@docmost/db/utils';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { PageAccessService } from '../page/page-access/page-access.service';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly notificationRepo: NotificationRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    @Optional()
    @Inject(WsGateway)
    private readonly wsGateway: WsGateway | undefined,
    private readonly mailService: MailService,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly lecAuthorization: LecAuthorizationService,
    private readonly users: UserRepo,
    private readonly pageAccess: PageAccessService,
  ) {}

  async create(data: InsertableNotification, trx?: KyselyTransaction) {
    const user = await this.users.findById(data.userId, data.workspaceId, {
      trx,
    });
    if (!user || user.deletedAt || user.deactivatedAt) return null;
    if (data.pageId) {
      const page = await dbOrTx(this.db, trx)
        .selectFrom('pages')
        .select(['id', 'workspaceId', 'spaceId', 'deletedAt'])
        .where('id', '=', data.pageId)
        .where('workspaceId', '=', data.workspaceId)
        .executeTakeFirst();
      if (!page) return null;
      try {
        await this.pageAccess.validateCanView(page, user);
      } catch (error) {
        if (error instanceof ForbiddenException) return null;
        throw error;
      }
    }

    const notification = await this.notificationRepo.insert(data, trx);

    if (!trx) this.publish(notification);
    return notification;
  }

  publish(notification: Pick<Notification, 'id' | 'userId' | 'type'>) {
    this.wsGateway?.server
      ?.to(`user-${notification.userId}`)
      .emit('notification', { id: notification.id, type: notification.type });
  }

  async filterRecipientsWithCoreView(
    userIds: string[],
    pageId: string,
    workspaceId: string,
  ): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const users = await this.db
      .selectFrom('users')
      .select(['id', 'workspaceId', 'deactivatedAt', 'deletedAt'])
      .where('id', 'in', [...new Set(userIds)])
      .where('workspaceId', '=', workspaceId)
      .execute();
    const active = users.filter(
      (user) => !user.deletedAt && !user.deactivatedAt,
    );
    const allowed = await Promise.all(
      active.map((user) =>
        this.lecAuthorization.filterPages(
          [{ id: pageId, workspaceId }],
          user as User,
        ),
      ),
    );
    return new Set(
      active
        .filter((_, index) => allowed[index].length > 0)
        .map((user) => user.id),
    );
  }

  async findByUserId(
    user: User,
    pagination: PaginationOptions,
    type: NotificationTab = 'all',
  ): Promise<CursorPaginationResult<Notification>> {
    const limit = pagination.limit;
    const backwards = Boolean(pagination.beforeCursor && !pagination.cursor);
    let cursor = pagination.cursor;
    let beforeCursor = pagination.beforeCursor;
    let exhausted = false;
    let authorized: Array<{
      id: string;
      pageId: string | null;
      workspaceId: string;
      $cursor: string;
    }> = [];

    for (let scanned = 0; scanned < 1000; scanned += 100) {
      const batch = await this.notificationRepo.findCandidates(
        user.id,
        { limit: 100, cursor, beforeCursor } as PaginationOptions,
        type,
      );
      const candidates = batch.items;
      if (candidates.length === 0) {
        exhausted = true;
        break;
      }
      const accepted = await this.filterAuthorized(candidates, user);
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
    const content = await this.notificationRepo.findContentByIds(
      selected.map((item) => item.id),
    );
    const byId = new Map(content.map((item) => [item.id, item]));
    const items = selected
      .map((item) => byId.get(item.id))
      .filter(Boolean) as Notification[];
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

  async getUnreadCount(user: User) {
    let count = 0;
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.notificationRepo.findCandidates(
        user.id,
        { limit: 100, cursor } as PaginationOptions,
        'all',
        true,
      );
      count += (await this.filterAuthorized(batch.items, user)).length;
      cursor = batch.meta.nextCursor ?? undefined;
      if (!cursor) return count;
    }
  }

  private async filterAuthorized<
    T extends { pageId: string | null; workspaceId: string },
  >(candidates: T[], user: User): Promise<T[]> {
    const pageCandidates = candidates.filter(
      (candidate): candidate is T & { pageId: string } => !!candidate.pageId,
    );
    const coreAllowed = await this.lecAuthorization.filterPages(
      pageCandidates.map((candidate) => ({
        id: candidate.pageId,
        workspaceId: candidate.workspaceId,
      })),
      user,
    );
    const coreAllowedIds = new Set(coreAllowed.map((page) => page.id));
    const locallyAllowed =
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: [...coreAllowedIds],
        userId: user.id,
      });
    const locallyAllowedIds = new Set(locallyAllowed);
    return candidates.filter(
      (candidate) =>
        !candidate.pageId ||
        (coreAllowedIds.has(candidate.pageId) &&
          locallyAllowedIds.has(candidate.pageId)),
    );
  }

  async markAsRead(notificationId: string, user: User) {
    return this.markMultipleAsRead([notificationId], user);
  }

  async markMultipleAsRead(notificationIds: string[], user: User) {
    return this.markAuthorizedAsRead(user, notificationIds);
  }

  async markAllAsRead(user: User) {
    return this.markAuthorizedAsRead(user);
  }

  private async markAuthorizedAsRead(user: User, notificationIds?: string[]) {
    const candidates = await this.notificationRepo.findReadCandidates(
      user.id,
      notificationIds,
    );
    const authorized = await this.filterAuthorized(candidates, user);
    return this.notificationRepo.markMultipleAsRead(
      authorized.map((candidate) => candidate.id),
      user.id,
    );
  }

  async queueEmail(
    userId: string,
    notificationId: string,
    subject: string,
    template: any,
    type?: NotificationType,
  ) {
    try {
      const notification = await this.notificationRepo.findById(notificationId);
      if (!notification || notification.userId !== userId) return;
      const user = await this.users.findById(userId, notification.workspaceId);
      if (!user?.email || user.deletedAt || user.deactivatedAt) return;
      if (notification.pageId) {
        const page = await this.db
          .selectFrom('pages')
          .select(['id', 'workspaceId', 'spaceId', 'deletedAt'])
          .where('id', '=', notification.pageId)
          .where('workspaceId', '=', notification.workspaceId)
          .executeTakeFirst();
        if (!page) return;
        try {
          await this.pageAccess.validateCanView(page, user);
        } catch (error) {
          if (error instanceof ForbiddenException) return;
          throw error;
        }
      }

      if (type) {
        const settingKey = NotificationTypeToSettingKey[type];
        if (settingKey) {
          const settings = user.settings as any;
          if (settings?.notifications?.[settingKey] === false) return;
        }
      }

      await this.mailService.sendToQueue({
        to: user.email,
        subject,
        template,
        notificationId,
      });
    } catch (err: unknown) {
      if (err instanceof ServiceUnavailableException) throw err;
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(
        `Failed to queue email for notification ${notificationId}: ${message}`,
      );
    }
  }
}
