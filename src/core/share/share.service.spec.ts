jest.mock('nanoid', () => ({
  customAlphabet: jest.fn(() => jest.fn()),
}));
jest.mock('uuid', () => ({
  v7: jest.fn(),
  validate: jest.fn(() => true),
}));
jest.mock('../../collaboration/collaboration.util', () => ({
  jsonToNode: jest.fn(),
}));

import { NotFoundException } from '@nestjs/common';
import { ShareService } from './share.service';

const PAGE_ID = '10000000-0000-4000-8000-000000000001';
const CHILD_ID = '10000000-0000-4000-8000-000000000002';
const SPACE_ID = '20000000-0000-4000-8000-000000000001';
const WORKSPACE_ID = '30000000-0000-4000-8000-000000000001';
const USER_ID = '40000000-0000-4000-8000-000000000001';

const share = {
  id: 'share',
  pageId: PAGE_ID,
  spaceId: SPACE_ID,
  workspaceId: WORKSPACE_ID,
  includeSubPages: true,
  searchIndexing: false,
};

const page = {
  id: PAGE_ID,
  workspaceId: WORKSPACE_ID,
  spaceId: SPACE_ID,
  deletedAt: null,
};

function makeService(overrides: Record<string, any> = {}) {
  const shareRepo = {
    findById: jest.fn().mockResolvedValue(share),
    findCandidates: jest.fn(),
    findContentByIds: jest.fn(),
    ...overrides.shareRepo,
  };
  const pageRepo = {
    findAuthorizationSubject: jest.fn().mockResolvedValue(page),
    findPageTreeCandidates: jest.fn().mockResolvedValue([
      { id: PAGE_ID, workspaceId: WORKSPACE_ID },
      { id: CHILD_ID, workspaceId: WORKSPACE_ID },
    ]),
    findById: jest.fn().mockResolvedValue(page),
    getPageAndDescendantsExcludingRestricted: jest.fn().mockResolvedValue([
      { id: PAGE_ID, title: 'Root', icon: null },
      { id: CHILD_ID, title: 'Child', icon: null },
    ]),
    ...overrides.pageRepo,
  };
  const pagePermissionRepo = {
    hasRestrictedAncestor: jest.fn().mockResolvedValue(false),
    ...overrides.pagePermissionRepo,
  };
  const authorization = {
    requirePage: jest.fn().mockResolvedValue({ allowed: true }),
    filterPages: jest.fn().mockImplementation(async (pages) => pages),
    ...overrides.authorization,
  };
  const db = overrides.db ?? ({} as any);
  const service = new ShareService(
    shareRepo as any,
    pageRepo as any,
    pagePermissionRepo as any,
    db,
    {} as any,
    {} as any,
    authorization as any,
  );

  return {
    service,
    shareRepo,
    pageRepo,
    pagePermissionRepo,
    authorization,
  };
}

describe('ShareService anonymous Core authorization', () => {
  it('does not read shared title or content when anonymous VIEW is denied', async () => {
    const db = { withRecursive: jest.fn() };
    const { service, pageRepo, pagePermissionRepo } = makeService({
      db,
      authorization: {
        requirePage: jest
          .fn()
          .mockRejectedValue(new Error('anonymous Core VIEW denied')),
      },
    });

    await expect(
      service.getSharedPage({ pageId: PAGE_ID } as any, WORKSPACE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(pageRepo.findById).not.toHaveBeenCalled();
    expect(pagePermissionRepo.hasRestrictedAncestor).not.toHaveBeenCalled();
  });

  it('does not read public share info when anonymous VIEW is denied', async () => {
    const { service, shareRepo } = makeService({
      authorization: {
        requirePage: jest
          .fn()
          .mockRejectedValue(new Error('anonymous Core VIEW denied')),
      },
    });

    await expect(service.getPublicShareInfo(share.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(shareRepo.findById).toHaveBeenCalledWith(share.id);
    expect(shareRepo.findById).not.toHaveBeenCalledWith(
      share.id,
      expect.objectContaining({ includeSharedPage: true }),
    );
  });

  it('filters share tree candidates before reading titles or icons', async () => {
    const candidates = [
      { id: PAGE_ID, workspaceId: WORKSPACE_ID },
      { id: CHILD_ID, workspaceId: WORKSPACE_ID },
    ];
    const findPageTreeCandidates = jest.fn().mockResolvedValue(candidates);
    const getPageAndDescendantsExcludingRestricted = jest
      .fn()
      .mockResolvedValue([{ id: PAGE_ID, title: 'Root', icon: null }]);
    const filterPages = jest.fn().mockResolvedValue([candidates[0]]);
    const { service } = makeService({
      pageRepo: {
        findPageTreeCandidates,
        getPageAndDescendantsExcludingRestricted,
      },
      authorization: { filterPages },
    });

    const result = await service.getShareTree(share.id, WORKSPACE_ID);

    expect(filterPages).toHaveBeenCalledWith(candidates, null);
    expect(findPageTreeCandidates.mock.invocationCallOrder[0]).toBeLessThan(
      getPageAndDescendantsExcludingRestricted.mock.invocationCallOrder[0],
    );
    expect(filterPages.mock.invocationCallOrder[0]).toBeLessThan(
      getPageAndDescendantsExcludingRestricted.mock.invocationCallOrder[0],
    );
    expect(getPageAndDescendantsExcludingRestricted).toHaveBeenCalledWith(
      PAGE_ID,
      { includeContent: false, pageIds: [PAGE_ID] },
    );
    expect(result.pageTree).toEqual([expect.objectContaining({ id: PAGE_ID })]);
  });

  it('404s the tree when anonymous Core denies the shared root page', async () => {
    const candidates = [
      { id: PAGE_ID, workspaceId: WORKSPACE_ID },
      { id: CHILD_ID, workspaceId: WORKSPACE_ID },
    ];
    const { service, pageRepo } = makeService({
      pageRepo: {
        findPageTreeCandidates: jest.fn().mockResolvedValue(candidates),
      },
      authorization: {
        filterPages: jest.fn().mockResolvedValue([candidates[1]]),
      },
    });

    await expect(
      service.getShareTree(share.id, WORKSPACE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(
      pageRepo.getPageAndDescendantsExcludingRestricted,
    ).not.toHaveBeenCalled();
  });
});

describe('ShareService authenticated share listing', () => {
  const user = { id: USER_ID, workspaceId: WORKSPACE_ID } as any;

  it('authorizes minimal candidates before local ACL and sensitive hydration, filling the page', async () => {
    const trace: string[] = [];
    const candidate = (id: string, pageId: string) => ({
      id,
      pageId,
      workspaceId: WORKSPACE_ID,
      $cursor: `${id}-cursor`,
    });
    const deniedByCore = candidate('share-1', 'page-1');
    const deniedByLocal = candidate('share-2', 'page-2');
    const allowedOne = candidate('share-3', 'page-3');
    const allowedTwo = candidate('share-4', 'page-4');
    const findCandidates = jest
      .fn()
      .mockImplementationOnce(async () => {
        trace.push('candidates-1');
        return {
          items: [deniedByCore, deniedByLocal, allowedOne],
          meta: { hasNextPage: true, nextCursor: 'batch-2' },
        };
      })
      .mockImplementationOnce(async () => {
        trace.push('candidates-2');
        return {
          items: [allowedTwo],
          meta: { hasNextPage: false, nextCursor: null },
        };
      });
    const filterPages = jest.fn().mockImplementation(async (pages) => {
      trace.push('core');
      return pages.filter((page) => page.id !== deniedByCore.pageId);
    });
    const filterAccessiblePageIds = jest
      .fn()
      .mockImplementation(async ({ pageIds }) => {
        trace.push('local');
        return pageIds.filter((id) => id !== deniedByLocal.pageId);
      });
    const findContentByIds = jest.fn().mockImplementation(async (ids) => {
      trace.push('content');
      return ids.map((id) => ({ id, page: { title: `title-${id}` } }));
    });
    const { service } = makeService({
      shareRepo: { findCandidates, findContentByIds },
      pagePermissionRepo: { filterAccessiblePageIds },
      authorization: { filterPages },
    });

    const result = await service.getShares(user, {
      limit: 2,
    } as any);

    expect(result.items.map((item) => item.id)).toEqual([
      allowedOne.id,
      allowedTwo.id,
    ]);
    expect(findCandidates).toHaveBeenNthCalledWith(
      1,
      USER_ID,
      WORKSPACE_ID,
      expect.objectContaining({ limit: 100 }),
    );
    expect(findCandidates).toHaveBeenNthCalledWith(
      2,
      USER_ID,
      WORKSPACE_ID,
      expect.objectContaining({ limit: 100, cursor: 'batch-2' }),
    );
    expect(findContentByIds).toHaveBeenCalledWith(
      [allowedOne.id, allowedTwo.id],
      USER_ID,
    );
    expect(trace).toEqual([
      'candidates-1',
      'core',
      'local',
      'candidates-2',
      'core',
      'local',
      'content',
    ]);
  });

  it('stops after the bounded candidate scan when authorized rows cannot fill the page', async () => {
    const findCandidates = jest
      .fn()
      .mockImplementation(async (_userId, _workspaceId, pagination) => {
        const batch = Number(
          (pagination.cursor as string | undefined)?.slice(6) ?? 0,
        );
        return {
          items: Array.from({ length: 100 }, (_, index) => ({
            id: `share-${batch}-${index}`,
            pageId: `page-${batch}-${index}`,
            workspaceId: WORKSPACE_ID,
            $cursor: `cursor-${batch}-${index}`,
          })),
          meta: { hasNextPage: true, nextCursor: `batch-${batch + 1}` },
        };
      });
    const filterAccessiblePageIds = jest.fn().mockResolvedValue([]);
    const findContentByIds = jest.fn();
    const { service } = makeService({
      shareRepo: { findCandidates, findContentByIds },
      pagePermissionRepo: { filterAccessiblePageIds },
      authorization: {
        filterPages: jest.fn().mockImplementation(async (pages) => pages),
      },
    });

    const result = await service.getShares(user, { limit: 20 } as any);

    expect(findCandidates).toHaveBeenCalledTimes(10);
    expect(findContentByIds).not.toHaveBeenCalled();
    expect(result.items).toEqual([]);
    expect(result.meta.hasNextPage).toBe(true);
  });

  it('fails closed on a Core outage without local ACL or sensitive hydration', async () => {
    const coreError = new Error('Core unavailable');
    const findCandidates = jest.fn().mockResolvedValue({
      items: [
        {
          id: 'share-1',
          pageId: PAGE_ID,
          workspaceId: WORKSPACE_ID,
          $cursor: 'cursor-1',
        },
      ],
      meta: { hasNextPage: false, nextCursor: null },
    });
    const filterAccessiblePageIds = jest.fn();
    const findContentByIds = jest.fn();
    const { service } = makeService({
      shareRepo: { findCandidates, findContentByIds },
      pagePermissionRepo: { filterAccessiblePageIds },
      authorization: {
        filterPages: jest.fn().mockRejectedValue(coreError),
      },
    });

    await expect(service.getShares(user, { limit: 20 } as any)).rejects.toBe(
      coreError,
    );
    expect(filterAccessiblePageIds).not.toHaveBeenCalled();
    expect(findContentByIds).not.toHaveBeenCalled();
  });
});
