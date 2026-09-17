import { Injectable } from '@nestjs/common';
import {
  FavoriteRepo,
  FavoriteType,
} from '@docmost/db/repos/favorite/favorite.repo';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { InsertableFavorite, User } from '@docmost/db/types/entity.types';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { LecAuthorizationService } from '../../lec-authorization/lec-authorization.service';
import { NotificationService } from '../../notification/notification.service';
import { NotificationType } from '../../notification/notification.constants';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';

@Injectable()
export class FavoriteService {
  constructor(
    private readonly favoriteRepo: FavoriteRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly lecAuthorization: LecAuthorizationService,
    private readonly notificationService: NotificationService,
    private readonly pageRepo: PageRepo,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  async getFavoriteIds(
    user: User,
    workspaceId: string,
    type: FavoriteType,
    spaceId?: string,
  ) {
    const limit = 250;
    let cursor: string | undefined;
    let exhausted = false;
    const authorized: Array<{ entityId: string; $cursor: string }> = [];

    while (authorized.length <= limit && !exhausted) {
      // Candidate pages expose only IDs/workspace; Core is the allow source,
      // and local page ACL can only narrow its result.
      const batch = await this.favoriteRepo.findFavoriteIdCandidates(
        user.id,
        workspaceId,
        type,
        spaceId,
        { limit: 100, cursor } as PaginationOptions,
      );
      if (batch.items.length === 0) {
        exhausted = true;
        break;
      }
      const candidates = batch.items.filter(
        (favorite): favorite is typeof favorite & { entityId: string } =>
          Boolean(favorite.entityId),
      );

      let allowed = candidates;
      if (type === FavoriteType.PAGE) {
        const coreAllowed = await this.lecAuthorization.filterPages(
          candidates.map((favorite) => ({
            id: favorite.entityId,
            workspaceId: favorite.workspaceId,
          })),
          user,
        );
        const locallyAllowed = coreAllowed.length
          ? await this.pagePermissionRepo.filterAccessiblePageIds({
              pageIds: coreAllowed.map((page) => page.id),
              userId: user.id,
            })
          : [];
        const accessible = new Set(locallyAllowed);
        allowed = candidates.filter((favorite) =>
          accessible.has(favorite.entityId),
        );
      }
      authorized.push(...allowed);

      cursor = batch.meta.nextCursor ?? undefined;
      exhausted = !cursor;
      if (authorized.length > limit || exhausted) break;
    }

    const selected = authorized.slice(0, limit);
    const hasMore = authorized.length > limit || !exhausted;
    return {
      items: selected.map((favorite) => favorite.entityId),
      meta: {
        limit,
        hasNextPage: hasMore,
        hasPrevPage: false,
        nextCursor: hasMore
          ? selected[selected.length - 1]?.$cursor ?? null
          : null,
        prevCursor: null,
      },
    };
  }

  async addFavorite(
    userId: string,
    workspaceId: string,
    opts: {
      type: FavoriteType;
      pageId?: string;
      spaceId?: string;
      templateId?: string;
    },
  ): Promise<void> {
    const favorite: InsertableFavorite = {
      userId,
      pageId: opts.pageId ?? null,
      spaceId: opts.spaceId ?? null,
      templateId: opts.templateId ?? null,
      type: opts.type,
      workspaceId,
    };

    const page =
      opts.type === FavoriteType.PAGE && opts.pageId
        ? await this.pageRepo.findAuthorizationSubject(opts.pageId)
        : undefined;
    const notification = await this.db.transaction().execute(async (trx) => {
      const inserted = await this.favoriteRepo.insert(favorite, trx);
      if (!inserted || !page?.creatorId || page.creatorId === userId) return;
      return this.notificationService.create(
        {
          userId: page.creatorId,
          workspaceId,
          type: NotificationType.PAGE_FAVORITED,
          actorId: userId,
          pageId: page.id,
          spaceId: page.spaceId,
        },
        trx,
      );
    });
    if (notification) this.notificationService.publish(notification);
  }

  async removeFavorite(
    userId: string,
    opts: {
      type: FavoriteType;
      pageId?: string;
      spaceId?: string;
      templateId?: string;
    },
  ): Promise<void> {
    if (opts.type === FavoriteType.PAGE && opts.pageId) {
      await this.favoriteRepo.deleteByUserAndPage(userId, opts.pageId);
    } else if (opts.type === FavoriteType.SPACE && opts.spaceId) {
      await this.favoriteRepo.deleteByUserAndSpace(userId, opts.spaceId);
    } else if (opts.type === FavoriteType.TEMPLATE && opts.templateId) {
      await this.favoriteRepo.deleteByUserAndTemplate(userId, opts.templateId);
    }
  }

  async getUserFavorites(
    user: User,
    workspaceId: string,
    pagination: PaginationOptions,
    type?: FavoriteType,
    spaceId?: string,
  ) {
    const limit = pagination.limit;
    const backwards = Boolean(pagination.beforeCursor && !pagination.cursor);
    let cursor = pagination.cursor;
    let beforeCursor = pagination.beforeCursor;
    let exhausted = false;
    let lastScannedCursor: string | undefined;
    let authorized: Array<{
      id: string;
      type: FavoriteType;
      pageId: string | null;
      workspaceId: string;
      $cursor: string;
    }> = [];

    for (let scanned = 0; scanned < 1000; scanned += 100) {
      const batch = await this.favoriteRepo.findUserFavoriteCandidates(
        user.id,
        workspaceId,
        { limit: 100, cursor, beforeCursor } as PaginationOptions,
        type,
        spaceId,
      );
      const candidates = batch.items.map((favorite) => ({
        ...favorite,
        type: favorite.type as FavoriteType,
      }));
      if (candidates.length === 0) {
        exhausted = true;
        break;
      }

      const pageFavorites = candidates.filter(
        (favorite): favorite is typeof favorite & { pageId: string } =>
          favorite.type === FavoriteType.PAGE && !!favorite.pageId,
      );
      const coreAllowed = await this.lecAuthorization.filterPages(
        pageFavorites.map((favorite) => ({
          id: favorite.pageId,
          workspaceId: favorite.workspaceId,
        })),
        user,
      );
      const accessibleIds =
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds: coreAllowed.map((page) => page.id),
          userId: user.id,
        });
      const accessible = new Set(accessibleIds);
      const allowed = candidates.filter(
        (favorite) =>
          favorite.type !== FavoriteType.PAGE ||
          (favorite.pageId && accessible.has(favorite.pageId)),
      );
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
    const selectedIds = selected.map((favorite) => favorite.id);
    const content = await this.favoriteRepo.findUserFavoriteContentByIds(
      selectedIds,
      type,
    );
    const byId = new Map(content.map((favorite) => [favorite.id, favorite]));
    const items = selectedIds.map((id) => byId.get(id)).filter(Boolean);
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
}
