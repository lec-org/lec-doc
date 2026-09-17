import { Injectable } from '@nestjs/common';
import { Page, User } from '@docmost/db/types/entity.types';
import { PageLikeRepo } from '@docmost/db/repos/page-like/page-like.repo';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/notification.constants';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';

@Injectable()
export class PageLikeService {
  constructor(
    private readonly pageLikeRepo: PageLikeRepo,
    private readonly notificationService: NotificationService,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  async like(user: User, page: Page) {
    const notification = await this.db.transaction().execute(async (trx) => {
      const inserted = await this.pageLikeRepo.insert(
        page.id,
        user.id,
        page.workspaceId,
        trx,
      );
      if (!inserted || page.creatorId === user.id) return;
      return this.notificationService.create(
        {
          userId: page.creatorId,
          workspaceId: page.workspaceId,
          type: NotificationType.PAGE_LIKED,
          actorId: user.id,
          pageId: page.id,
          spaceId: page.spaceId,
        },
        trx,
      );
    });
    if (notification) this.notificationService.publish(notification);
    return { liked: true };
  }

  async unlike(userId: string, pageId: string) {
    await this.pageLikeRepo.delete(pageId, userId);
    return { liked: false };
  }

  async status(userId: string, pageId: string) {
    return { liked: await this.pageLikeRepo.isLiked(pageId, userId) };
  }
}
