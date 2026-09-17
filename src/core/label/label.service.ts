import { Injectable, NotFoundException } from '@nestjs/common';
import { Label, User } from '@docmost/db/types/entity.types';
import { LabelRepo, LabelType } from '@docmost/db/repos/label/label.repo';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { normalizeLabelName } from './utils';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventName } from 'src/common/events/event.contants';
import { LecAuthorizationService } from '../lec-authorization/lec-authorization.service';

@Injectable()
export class LabelService {
  constructor(
    private readonly labelRepo: LabelRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly eventEmitter: EventEmitter2,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly lecAuthorization: LecAuthorizationService,
  ) {}

  async addLabelsToPage(
    pageId: string,
    names: string[],
    workspaceId: string,
  ): Promise<Label[]> {
    const attached: Label[] = [];
    await executeTx(this.db, async (trx) => {
      for (const name of names) {
        const label = await this.labelRepo.findOrCreate(
          name.trim(),
          workspaceId,
          LabelType.PAGE,
          trx,
        );
        await this.labelRepo.addLabelToPage(pageId, label.id, trx);
        attached.push(label);
      }
    });

    this.eventEmitter.emit(EventName.PAGE_UPDATED, {
      pageIds: [pageId],
      workspaceId: workspaceId,
    });
    
    return attached;
  }

  async removeLabelFromPage(
    pageId: string,
    labelId: string,
    workspaceId: string,
  ): Promise<void> {
    await executeTx(this.db, async (trx) => {
      const label = await this.labelRepo.findById(labelId, trx);
      if (!label || label.workspaceId !== workspaceId) {
        throw new NotFoundException('Label not found');
      }

      await this.labelRepo.removeLabelFromPage(
        pageId,
        labelId,
        workspaceId,
        trx,
      );

      const count = await this.labelRepo.getLabelPageCount(
        labelId,
        workspaceId,
        trx,
      );
      if (count === 0) {
        await this.labelRepo.deleteLabel(labelId, workspaceId, trx);
      }
    });

    this.eventEmitter.emit(EventName.PAGE_UPDATED, {
      pageIds: [pageId],
      workspaceId: workspaceId,
    });
  }

  async getPageLabels(pageId: string, pagination: PaginationOptions) {
    return this.labelRepo.findLabelsByPageId(pageId, pagination);
  }

  async getLabels(
    user: User,
    type: LabelType,
    pagination: PaginationOptions,
  ) {
    const limit = pagination.limit;
    const backwards = Boolean(pagination.beforeCursor && !pagination.cursor);
    let cursor = pagination.cursor;
    let beforeCursor = pagination.beforeCursor;
    let exhausted = false;
    let authorized: Array<{
      id: string;
      workspaceId: string;
      $cursor: string;
    }> = [];

    while (authorized.length < limit && !exhausted) {
      const batch = await this.labelRepo.findLabelCandidates(
        user.workspaceId,
        user.id,
        type,
        {
          ...pagination,
          limit: 100,
          cursor,
          beforeCursor,
        } as PaginationOptions,
      );
      const candidates = batch.items;
      if (candidates.length === 0) {
        exhausted = true;
        break;
      }

      const counts = await this.getAuthorizedLabelPageCounts(
        candidates.map((label) => label.id),
        user,
        undefined,
        true,
      );
      const allowed = candidates.filter((label) => counts.has(label.id));
      authorized = backwards
        ? [...allowed, ...authorized]
        : [...authorized, ...allowed];

      if (backwards) {
        beforeCursor = candidates[0].$cursor;
        exhausted = !batch.meta.hasNextPage;
      } else {
        cursor = batch.meta.nextCursor ?? undefined;
        exhausted = !cursor;
      }
    }

    const selected = backwards
      ? authorized.slice(-limit)
      : authorized.slice(0, limit);
    const content = selected.length
      ? await this.labelRepo.findLabelContentByIds(
          selected.map((label) => label.id),
        )
      : [];
    const byId = new Map(content.map((label) => [label.id, label]));
    const items = selected
      .map((label) => byId.get(label.id))
      .filter(Boolean) as Label[];
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

  async hasAuthorizedPages(
    labelId: string,
    user: User,
    spaceId?: string,
  ): Promise<boolean> {
    return (
      await this.getAuthorizedLabelPageCounts([labelId], user, spaceId, true)
    ).has(labelId);
  }

  async findPagesByLabel(
    labelId: string,
    user: User,
    opts: {
      spaceId?: string;
      query?: string;
      pagination: PaginationOptions;
    },
  ) {
    const { pagination } = opts;
    const limit = pagination.limit;
    const backwards = Boolean(pagination.beforeCursor && !pagination.cursor);
    let cursor = pagination.cursor;
    let beforeCursor = pagination.beforeCursor;
    let exhausted = false;
    let lastScannedCursor: string | undefined;
    let authorized: Array<{
      id: string;
      workspaceId: string;
      $cursor: string;
    }> = [];

    for (let scanned = 0; scanned < 1000; scanned += 100) {
      const batch = await this.labelRepo.findPageCandidatesByLabelId(
        labelId,
        user.id,
        {
          ...opts,
          pagination: {
            limit: 100,
            cursor,
            beforeCursor,
          } as PaginationOptions,
        },
      );
      const candidates = batch.items;
      if (candidates.length === 0) {
        exhausted = true;
        break;
      }

      const coreAllowed = await this.lecAuthorization.filterPages(
        candidates.map((candidate) => ({
          id: candidate.id,
          workspaceId: candidate.workspaceId,
        })),
        user,
      );
      const accessibleIds = coreAllowed.length
        ? await this.pagePermissionRepo.filterAccessiblePageIds({
            pageIds: coreAllowed.map((candidate) => candidate.id),
            userId: user.id,
            spaceId: opts.spaceId,
          })
        : [];
      const accessible = new Set(accessibleIds);
      const allowed = candidates.filter((candidate) =>
        accessible.has(candidate.id),
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
    const selectedIds = selected.map((candidate) => candidate.id);
    const content = await this.labelRepo.findPageContentByIds(selectedIds);
    const byId = new Map(content.map((page) => [page.id, page]));
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

  async getLabelInfo(
    name: string,
    type: LabelType,
    user: User,
    spaceId?: string,
  ) {
    const normalized = normalizeLabelName(name);
    const label = await this.labelRepo.findIdByNameAndWorkspace(
      normalized,
      user.workspaceId,
      type,
    );
    const counts = label
      ? await this.getAuthorizedLabelPageCounts(
          [label.id],
          user,
          spaceId,
          false,
        )
      : new Map<string, number>();

    return {
      name: normalized,
      usageCount: label ? (counts.get(label.id) ?? 0) : 0,
    };
  }

  private async getAuthorizedLabelPageCounts(
    labelIds: string[],
    user: User,
    spaceId: string | undefined,
    stopWhenEveryLabelFound: boolean,
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    let cursor: string | undefined;

    for (;;) {
      const batch = await this.labelRepo.findPageCandidatesByLabelIds(
        labelIds,
        user.id,
        {
          spaceId,
          pagination: { limit: 100, cursor } as PaginationOptions,
        },
      );
      if (batch.items.length === 0) break;

      const coreAllowed = await this.lecAuthorization.filterPages(
        batch.items.map((candidate) => ({
          id: candidate.id,
          workspaceId: candidate.workspaceId,
        })),
        user,
      );
      const locallyAllowed = coreAllowed.length
        ? await this.pagePermissionRepo.filterAccessiblePageIds({
            pageIds: coreAllowed.map((page) => page.id),
            userId: user.id,
            spaceId,
          })
        : [];
      const accessible = new Set(locallyAllowed);
      for (const candidate of batch.items) {
        if (!accessible.has(candidate.id)) continue;
        counts.set(candidate.labelId, (counts.get(candidate.labelId) ?? 0) + 1);
      }

      if (stopWhenEveryLabelFound && labelIds.every((id) => counts.has(id))) {
        break;
      }
      cursor = batch.meta.nextCursor ?? undefined;
      if (!cursor) break;
    }

    return counts;
  }
}
