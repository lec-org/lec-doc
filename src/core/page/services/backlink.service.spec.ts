jest.mock('uuid', () => ({
  v7: jest.fn(),
  validate: jest.fn(() => true),
}));
jest.mock('nanoid', () => ({
  customAlphabet: jest.fn(() => jest.fn()),
}));

import { BacklinkRepo } from '@docmost/db/repos/backlink/backlink.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { User } from '@docmost/db/types/entity.types';
import { LecAuthorizationService } from '../../lec-authorization/lec-authorization.service';
import { BacklinkDirection, BacklinkService } from './backlink.service';

const pageId = '00000000-0000-0000-0000-000000000001';
const user = {
  id: '00000000-0000-0000-0000-000000000099',
  workspaceId: '00000000-0000-0000-0000-000000000098',
} as User;

type Candidate = {
  id: string;
  workspaceId: string;
  updatedAt: Date;
  $cursor: string;
};

function candidate(index: number): Candidate {
  return {
    id: `page-${index}`,
    workspaceId: user.workspaceId,
    updatedAt: new Date(2_000_000 - index),
    $cursor: `cursor-${index}`,
  };
}

function candidatePage(
  candidates: Candidate[],
  pagination: { limit: number; cursor?: string },
) {
  const start = pagination.cursor
    ? candidates.findIndex((item) => item.$cursor === pagination.cursor) + 1
    : 0;
  const items = candidates.slice(start, start + pagination.limit);
  const hasNextPage = start + items.length < candidates.length;
  return {
    items,
    meta: {
      limit: pagination.limit,
      hasNextPage,
      hasPrevPage: Boolean(pagination.cursor),
      nextCursor: hasNextPage ? items[items.length - 1]?.$cursor : null,
      prevCursor: pagination.cursor ? items[0]?.$cursor : null,
    },
  };
}

function makeService(opts?: {
  candidates?: Partial<Record<BacklinkDirection, Candidate[]>>;
  core?: jest.Mock;
  local?: jest.Mock;
}) {
  const candidates = opts?.candidates ?? {};
  const trace: string[] = [];
  const backlinkRepo = {
    findRelatedPageCandidates: jest.fn(
      async (
        _pageId: string,
        direction: BacklinkDirection,
        _userId: string,
        _workspaceId: string,
        pagination: { limit: number; cursor?: string },
      ) => {
        trace.push(`candidates:${direction}`);
        return candidatePage(candidates[direction] ?? [], pagination);
      },
    ),
    findPageContentByIds: jest.fn(async (ids: string[]) => {
      trace.push('content');
      return ids.map((id) => ({ id, title: `title-${id}` }));
    }),
  };
  const authorization = {
    filterPages:
      opts?.core ??
      jest.fn(async (pages: Array<{ id: string }>) => {
        trace.push('core');
        return pages;
      }),
  };
  const pagePermissionRepo = {
    filterAccessiblePageIds:
      opts?.local ??
      jest.fn(async ({ pageIds }: { pageIds: string[] }) => {
        trace.push('local');
        return pageIds;
      }),
  };
  const service = new BacklinkService(
    backlinkRepo as unknown as BacklinkRepo,
    pagePermissionRepo as unknown as PagePermissionRepo,
    authorization as unknown as LecAuthorizationService,
  );
  return { service, backlinkRepo, authorization, pagePermissionRepo, trace };
}

describe('BacklinkService candidate-first pagination', () => {
  it('scans past more than 1000 denied candidates, fills the page, and resumes after the returned row', async () => {
    const candidates = Array.from({ length: 1003 }, (_, index) =>
      candidate(index),
    );
    const allowedIds = new Set(['page-1001', 'page-1002']);
    const core = jest.fn(async (pages: Array<{ id: string }>) =>
      pages.filter((page) => allowedIds.has(page.id)),
    );
    const local = jest.fn(
      async ({ pageIds }: { pageIds: string[] }) => pageIds,
    );
    const fixture = makeService({
      candidates: { incoming: candidates },
      core,
      local,
    });

    const first = await fixture.service.findByPageId(pageId, 'incoming', user, {
      limit: 1,
    } as any);

    expect(first.items).toEqual([
      expect.objectContaining({ id: 'page-1001', title: 'title-page-1001' }),
    ]);
    expect(first.meta).toEqual(
      expect.objectContaining({
        limit: 1,
        hasNextPage: true,
        nextCursor: 'cursor-1001',
      }),
    );
    expect(
      fixture.backlinkRepo.findRelatedPageCandidates,
    ).toHaveBeenCalledTimes(11);
    expect(
      fixture.backlinkRepo.findRelatedPageCandidates.mock.calls.every(
        (call) => call[4].limit === 100,
      ),
    ).toBe(true);
    expect(core.mock.calls.every(([pages]) => pages.length <= 100)).toBe(true);
    expect(local).toHaveBeenCalledTimes(1);
    expect(fixture.backlinkRepo.findPageContentByIds).toHaveBeenCalledWith(
      ['page-1001'],
      user.workspaceId,
    );

    const second = await fixture.service.findByPageId(
      pageId,
      'incoming',
      user,
      { limit: 1, cursor: first.meta.nextCursor } as any,
    );

    expect(second.items).toEqual([
      expect.objectContaining({ id: 'page-1002', title: 'title-page-1002' }),
    ]);
    expect(second.meta.nextCursor).toBeNull();
    expect(
      fixture.backlinkRepo.findRelatedPageCandidates,
    ).toHaveBeenLastCalledWith(
      pageId,
      'incoming',
      user.id,
      user.workspaceId,
      expect.objectContaining({ limit: 100, cursor: 'cursor-1001' }),
    );
  });

  it('runs Core before local ACL and sensitive hydration', async () => {
    const trace: string[] = [];
    const fixture = makeService({
      candidates: { incoming: [candidate(0)] },
      core: jest.fn(async (pages) => {
        trace.push('core');
        return pages;
      }),
      local: jest.fn(async ({ pageIds }) => {
        trace.push('local');
        return pageIds;
      }),
    });
    fixture.backlinkRepo.findPageContentByIds.mockImplementation(
      async (ids) => {
        trace.push('content');
        return ids.map((id) => ({ id, title: 'Sensitive' }));
      },
    );

    await fixture.service.findByPageId(pageId, 'incoming', user, {
      limit: 1,
    } as any);

    expect(trace).toEqual(['core', 'local', 'content']);
  });

  it('fails closed on a Core outage before local ACL or hydration', async () => {
    const outage = new Error('Core unavailable');
    const local = jest.fn();
    const fixture = makeService({
      candidates: { incoming: [candidate(0)] },
      core: jest.fn().mockRejectedValue(outage),
      local,
    });

    await expect(
      fixture.service.findByPageId(pageId, 'incoming', user, {
        limit: 1,
      } as any),
    ).rejects.toBe(outage);
    expect(local).not.toHaveBeenCalled();
    expect(fixture.backlinkRepo.findPageContentByIds).not.toHaveBeenCalled();
  });
});

describe('BacklinkService authorized counts', () => {
  it('streams every direction in batches of at most 100 without materializing all ids', async () => {
    const incoming = Array.from({ length: 1205 }, (_, index) =>
      candidate(index),
    );
    const outgoing = Array.from({ length: 203 }, (_, index) => ({
      ...candidate(index),
      id: `out-${index}`,
    }));
    const core = jest.fn(async (pages: Array<{ id: string }>) =>
      pages.filter((page) => {
        const parts = page.id.split('-');
        const index = Number(parts[parts.length - 1]);
        return index % 2 === 0;
      }),
    );
    const local = jest.fn(
      async ({ pageIds }: { pageIds: string[] }) => pageIds,
    );
    const fixture = makeService({
      candidates: { incoming, outgoing },
      core,
      local,
    });

    await expect(fixture.service.countByPageId(pageId, user)).resolves.toEqual({
      incoming: 603,
      outgoing: 102,
    });

    expect(
      fixture.backlinkRepo.findRelatedPageCandidates.mock.calls.every(
        (call) => call[4].limit === 100,
      ),
    ).toBe(true);
    expect(core.mock.calls.every(([pages]) => pages.length <= 100)).toBe(true);
    expect(
      local.mock.calls.every(([{ pageIds }]) => pageIds.length <= 100),
    ).toBe(true);
    expect(fixture.backlinkRepo.findPageContentByIds).not.toHaveBeenCalled();
  });
});
