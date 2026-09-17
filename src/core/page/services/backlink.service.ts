import { Injectable } from '@nestjs/common';
import { BacklinkRepo } from '@docmost/db/repos/backlink/backlink.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { User } from '@docmost/db/types/entity.types';
import { LecAuthorizationService } from '../../lec-authorization/lec-authorization.service';

export type BacklinkDirection = 'incoming' | 'outgoing';

type BacklinkCandidate = {
  id: string;
  workspaceId: string;
  updatedAt: Date;
  $cursor: string;
};

const CANDIDATE_BATCH_SIZE = 100;

@Injectable()
export class BacklinkService {
  constructor(
    private readonly backlinkRepo: BacklinkRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly lecAuthorization: LecAuthorizationService,
  ) {}

  async countByPageId(
    pageId: string,
    user: User,
  ): Promise<{ incoming: number; outgoing: number }> {
    const [incoming, outgoing] = await Promise.all([
      this.countAccessible(pageId, 'incoming', user),
      this.countAccessible(pageId, 'outgoing', user),
    ]);
    return { incoming, outgoing };
  }

  async findByPageId(
    pageId: string,
    direction: BacklinkDirection,
    user: User,
    pagination: PaginationOptions,
  ) {
    const limit = pagination.limit;
    const backwards = Boolean(pagination.beforeCursor && !pagination.cursor);
    let cursor = pagination.cursor;
    let beforeCursor = pagination.beforeCursor;
    let exhausted = false;
    let lastScannedCursor: string | undefined;
    let authorized: BacklinkCandidate[] = [];

    while (!exhausted && authorized.length < limit) {
      const batch = await this.backlinkRepo.findRelatedPageCandidates(
        pageId,
        direction,
        user.id,
        user.workspaceId,
        {
          limit: CANDIDATE_BATCH_SIZE,
          cursor,
          beforeCursor,
        } as PaginationOptions,
      );
      const candidates = batch.items as BacklinkCandidate[];
      if (candidates.length === 0) {
        exhausted = true;
        break;
      }

      const allowed = await this.authorizeCandidates(candidates, user);
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
    }

    const selected = backwards
      ? authorized.slice(-limit)
      : authorized.slice(0, limit);
    const selectedIds = selected.map((candidate) => candidate.id);
    const content = selectedIds.length
      ? await this.backlinkRepo.findPageContentByIds(
          selectedIds,
          user.workspaceId,
        )
      : [];
    const contentById = new Map(content.map((page) => [page.id, page]));
    const items = selectedIds
      .map((id) => contentById.get(id))
      .filter((page) => page !== undefined);
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

  private async countAccessible(
    pageId: string,
    direction: BacklinkDirection,
    user: User,
  ): Promise<number> {
    let cursor: string | undefined;
    let count = 0;

    do {
      const batch = await this.backlinkRepo.findRelatedPageCandidates(
        pageId,
        direction,
        user.id,
        user.workspaceId,
        { limit: CANDIDATE_BATCH_SIZE, cursor } as PaginationOptions,
      );
      const candidates = batch.items as BacklinkCandidate[];
      if (candidates.length === 0) break;
      count += (await this.authorizeCandidates(candidates, user)).length;
      cursor = batch.meta.nextCursor ?? undefined;
    } while (cursor);

    return count;
  }

  private async authorizeCandidates(
    candidates: BacklinkCandidate[],
    user: User,
  ): Promise<BacklinkCandidate[]> {
    const coreAllowed = await this.lecAuthorization.filterPages(
      candidates.map(({ id, workspaceId }) => ({ id, workspaceId })),
      user,
    );
    if (coreAllowed.length === 0) return [];
    const accessibleIds = await this.pagePermissionRepo.filterAccessiblePageIds(
      {
        pageIds: coreAllowed.map((page) => page.id),
        userId: user.id,
      },
    );
    const accessible = new Set(accessibleIds);
    return candidates.filter((page) => accessible.has(page.id));
  }
}
