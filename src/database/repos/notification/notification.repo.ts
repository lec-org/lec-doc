import { ConflictException, Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import {
  InsertableNotification,
  Notification,
} from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';
import { ExpressionBuilder, sql } from 'kysely';
import { DB } from '@docmost/db/types/db';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { executeTx } from '@docmost/db/utils';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import {
  NotificationTab,
  NotificationType,
} from '../../../core/notification/notification.constants';

@Injectable()
export class NotificationRepo {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly spaceMemberRepo: SpaceMemberRepo,
  ) {}

  async findById(notificationId: string): Promise<Notification | undefined> {
    return this.db
      .selectFrom('notifications')
      .selectAll('notifications')
      .where('id', '=', notificationId)
      .executeTakeFirst();
  }

  async findCandidates(
    userId: string,
    pagination: PaginationOptions,
    type: NotificationTab = 'all',
    unreadOnly = false,
  ) {
    let query = this.db
      .selectFrom('notifications')
      .select(['id', 'pageId', 'workspaceId'])
      .where('userId', '=', userId)
      .where((eb) =>
        eb.or([
          eb('spaceId', 'is', null),
          eb(
            'spaceId',
            'in',
            this.spaceMemberRepo.getUserSpaceIdsQuery(userId),
          ),
        ]),
      );

    if (type === 'direct') {
      query = query.where('type', '!=', NotificationType.PAGE_UPDATED);
    } else if (type === 'updates') {
      query = query.where('type', '=', NotificationType.PAGE_UPDATED);
    }
    if (unreadOnly) query = query.where('readAt', 'is', null);

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      cursorPerRow: true,
      fields: [{ expression: 'id', direction: 'desc' }],
      parseCursor: (cursor) => ({ id: cursor.id }),
    });
  }

  async findContentByIds(notificationIds: string[]) {
    if (notificationIds.length === 0) return [];
    return this.db
      .selectFrom('notifications')
      .selectAll('notifications')
      .select((eb) => this.withActor(eb))
      .select((eb) => this.withPage(eb))
      .select((eb) => this.withSpace(eb))
      .where('id', 'in', notificationIds)
      .execute();
  }

  async insert(
    notification: InsertableNotification,
    trx?: KyselyTransaction,
  ): Promise<Notification> {
    return executeTx(
      this.db,
      async (trx) => {
        const created = await trx
          .insertInto('notifications')
          .values(notification)
          .onConflict((oc) => oc.column('id').doNothing())
          .returningAll()
          .executeTakeFirst();
        if (!created) {
          if (!notification.id)
            throw new ConflictException('notification insertion conflict');
          const existing = await trx
            .selectFrom('notifications')
            .selectAll()
            .where('id', '=', notification.id)
            .executeTakeFirstOrThrow();
          if (
            existing.userId !== notification.userId ||
            existing.workspaceId !== notification.workspaceId ||
            existing.type !== notification.type ||
            existing.pageId !== (notification.pageId ?? null) ||
            existing.actorId !== (notification.actorId ?? null)
          )
            throw new ConflictException('notification idempotency conflict');
          return existing;
        }
        if (created.pageId) {
          await trx
            .insertInto('lecDocumentNotificationOutbox')
            .values({ notificationId: created.id, availableAt: sql`now()` })
            .onConflict((oc) => oc.doNothing())
            .execute();
        }
        return created;
      },
      trx,
    );
  }

  async findReadCandidates(userId: string, notificationIds?: string[]) {
    let query = this.db
      .selectFrom('notifications')
      .select(['id', 'pageId', 'workspaceId'])
      .where('userId', '=', userId)
      .where('readAt', 'is', null);
    if (notificationIds) query = query.where('id', 'in', notificationIds);
    return query.execute();
  }

  async markMultipleAsRead(
    notificationIds: string[],
    userId: string,
  ): Promise<void> {
    if (notificationIds.length === 0) {
      return;
    }
    await this.db
      .updateTable('notifications')
      .set({ readAt: new Date() })
      .where('id', 'in', notificationIds)
      .where('userId', '=', userId)
      .where('readAt', 'is', null)
      .execute();
  }

  async markAsEmailed(notificationId: string): Promise<void> {
    await this.db
      .updateTable('notifications')
      .set({ emailedAt: new Date() })
      .where('id', '=', notificationId)
      .where('emailedAt', 'is', null)
      .execute();
  }

  async getRecentlyNotifiedUserIds(
    userIds: string[],
    pageId: string,
    type: string,
    withinHours: number,
  ): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();

    const cutoff = new Date(Date.now() - withinHours * 60 * 60 * 1000);

    const rows = await this.db
      .selectFrom('notifications')
      .select('userId')
      .where('userId', 'in', userIds)
      .where('pageId', '=', pageId)
      .where('type', '=', type)
      .where('createdAt', '>', cutoff)
      .groupBy('userId')
      .execute();

    return new Set(rows.map((r) => r.userId));
  }

  withActor(eb: ExpressionBuilder<DB, 'notifications'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('users')
        .select(['users.id', 'users.name', 'users.avatarUrl'])
        .whereRef('users.id', '=', 'notifications.actorId'),
    ).as('actor');
  }

  withPage(eb: ExpressionBuilder<DB, 'notifications'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('pages')
        .select(['pages.id', 'pages.title', 'pages.slugId', 'pages.icon'])
        .whereRef('pages.id', '=', 'notifications.pageId'),
    ).as('page');
  }

  withSpace(eb: ExpressionBuilder<DB, 'notifications'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('spaces')
        .select(['spaces.id', 'spaces.name', 'spaces.slug'])
        .whereRef('spaces.id', '=', 'notifications.spaceId'),
    ).as('space');
  }
}
