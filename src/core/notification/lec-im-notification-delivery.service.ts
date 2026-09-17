import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { PageAccessService } from '../page/page-access/page-access.service';
import { LecImNotificationClient } from './lec-im-notification.client';
import { NotificationType } from './notification.constants';

const DELIVERY_TEXT: Record<string, string> = {
  [NotificationType.COMMENT_USER_MENTION]: '你在一条云文档评论中被提及',
  [NotificationType.COMMENT_CREATED]: '你关注的云文档有新评论',
  [NotificationType.COMMENT_RESOLVED]: '你参与的云文档评论已解决',
  [NotificationType.PAGE_USER_MENTION]: '你在一篇云文档中被提及',
  [NotificationType.PAGE_PERMISSION_GRANTED]: '你获得了一篇云文档的访问权限',
  [NotificationType.PAGE_UPDATED]: '你关注的云文档已更新',
  [NotificationType.PAGE_FAVORITED]: '有人收藏了你的云文档',
  [NotificationType.PAGE_LIKED]: '有人点赞了你的云文档',
  [NotificationType.PAGE_VERIFICATION_EXPIRING]: '一篇云文档的验证即将到期',
  [NotificationType.PAGE_VERIFICATION_EXPIRED]: '一篇云文档的验证已过期',
  [NotificationType.PAGE_VERIFIED]: '一篇云文档已通过验证',
  [NotificationType.PAGE_APPROVAL_REQUESTED]: '一篇云文档等待你的审批',
  [NotificationType.PAGE_APPROVAL_REJECTED]: '一篇云文档的审批被拒绝',
};

type Claimed = {
  notificationId: string;
  attempts: number;
};

@Injectable()
export class LecImNotificationDeliveryService {
  private readonly logger = new Logger(
    LecImNotificationDeliveryService.name,
  );

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly users: UserRepo,
    private readonly pageAccess: PageAccessService,
    private readonly client: LecImNotificationClient,
  ) {}

  @Interval('lec-im-document-notifications', 1_000)
  async reconcile(): Promise<void> {
    if (!this.client.configured()) return;
    try {
      for (let processed = 0; processed < 20; processed++) {
        const claimed = await this.claim();
        if (!claimed) return;
        await this.process(claimed);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Document notification delivery failed: ${message}`);
    }
  }

  private async claim(): Promise<Claimed | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const now = new Date();
      const event = await trx
        .selectFrom('lecDocumentNotificationOutbox')
        .select(['notificationId', 'attempts'])
        .where('completedAt', 'is', null)
        .where('availableAt', '<=', now)
        .where((eb) =>
          eb.or([eb('leaseUntil', 'is', null), eb('leaseUntil', '<', now)]),
        )
        .orderBy('availableAt')
        .orderBy('createdAt')
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!event) return undefined;
      const attempts = event.attempts + 1;
      await trx
        .updateTable('lecDocumentNotificationOutbox')
        .set({
          attempts,
          leaseUntil: new Date(now.getTime() + 30_000),
          updatedAt: now,
        })
        .where('notificationId', '=', event.notificationId)
        .where('attempts', '=', event.attempts)
        .executeTakeFirstOrThrow();
      return { notificationId: event.notificationId, attempts };
    });
  }

  private async process(claimed: Claimed): Promise<void> {
    try {
      const notification = await this.db
        .selectFrom('notifications')
        .select(['id', 'userId', 'workspaceId', 'pageId', 'type'])
        .where('id', '=', claimed.notificationId)
        .executeTakeFirst();
      if (!notification?.pageId) return this.suppress(claimed.notificationId);
      const [page, user, identity] = await Promise.all([
        this.db
          .selectFrom('pages')
          .select(['id', 'workspaceId', 'spaceId', 'deletedAt'])
          .where('id', '=', notification.pageId)
          .executeTakeFirst(),
        this.users.findById(notification.userId, notification.workspaceId),
        this.db
          .selectFrom('lecIdentities')
          .select(['issuer', 'subject'])
          .where('userId', '=', notification.userId)
          .where('workspaceId', '=', notification.workspaceId)
          .executeTakeFirst(),
      ]);
      if (!page || !user || !identity)
        return this.suppress(claimed.notificationId);
      await this.pageAccess.validateCanView(page, user);
      const text = DELIVERY_TEXT[notification.type];
      if (!text) return this.suppress(claimed.notificationId);
      await this.client.send({
        event_id: notification.id,
        workspace_id: notification.workspaceId,
        resource_id: notification.pageId,
        recipient: identity,
        event_type: notification.type.toUpperCase().replaceAll('.', '_'),
        text,
      });
      await this.complete(claimed.notificationId, false);
    } catch (error) {
      if (error instanceof ForbiddenException) {
        await this.suppress(claimed.notificationId);
        return;
      }
      await this.retry(claimed, error);
    }
  }

  private suppress(notificationId: string) {
    return this.complete(notificationId, true);
  }

  private async complete(notificationId: string, suppressed: boolean) {
    const now = new Date();
    await this.db
      .updateTable('lecDocumentNotificationOutbox')
      .set({
        completedAt: now,
        suppressedAt: suppressed ? now : null,
        leaseUntil: null,
        lastError: null,
        updatedAt: now,
      })
      .where('notificationId', '=', notificationId)
      .where('completedAt', 'is', null)
      .execute();
  }

  private async retry(claimed: Claimed, error: unknown) {
    const now = new Date();
    const message =
      error instanceof ServiceUnavailableException
        ? 'dependency unavailable'
        : error instanceof Error
          ? error.message.slice(0, 500)
          : 'unknown error';
    await this.db
      .updateTable('lecDocumentNotificationOutbox')
      .set({
        availableAt: new Date(
          now.getTime() + 1000 * 2 ** Math.min(claimed.attempts, 8),
        ),
        leaseUntil: null,
        lastError: message,
        updatedAt: now,
      })
      .where('notificationId', '=', claimed.notificationId)
      .where('completedAt', 'is', null)
      .execute();
  }
}
