jest.mock('uuid', () => ({
  v7: jest.fn(),
  validate: jest.fn(() => true),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { User } from '@docmost/db/types/entity.types';
import { LecAuthorizationService } from '../../lec-authorization/lec-authorization.service';
import { LecResourceLifecycleService } from '../../lec-authorization/lec-resource-lifecycle.service';
import { QueueName } from '../../../integrations/queue/constants';
import { PageService } from './page.service';
import { PageMaintenanceService } from './page-maintenance.service';

const user = { id: 'user', workspaceId: 'workspace' } as User;

describe('PageService', () => {
  let service: PageService;
  const pageRepo = {
    findPageListCandidates: jest.fn(),
    findPageListContentByIds: jest.fn(),
    findSidebarCandidates: jest.fn(),
    findSidebarContentByIds: jest.fn(),
    findChildPageCandidates: jest.fn(),
  };
  const permissions = {
    filterAccessiblePageIds: jest.fn(),
    hasRestrictedPagesInSpace: jest.fn(),
  };
  const authorization = { filterPages: jest.fn() };
  const lifecycle = { requireDeletedTree: jest.fn() };
  const attachmentQueue = { add: jest.fn() };
  const db = {
    withRecursive: jest.fn(),
    deleteFrom: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [PageService],
    })
      .useMocker((token) => {
        if (token === PageRepo) return pageRepo;
        if (token === PagePermissionRepo) return permissions;
        if (token === LecAuthorizationService) return authorization;
        if (token === LecResourceLifecycleService) return lifecycle;
        if (token === PageMaintenanceService)
          return {
            forceDelete: (pageId: string, workspaceId: string) => {
              const maintenance = new PageMaintenanceService(
                db as any,
                attachmentQueue as any,
                lifecycle as any,
              );
              return maintenance.forceDelete(pageId, workspaceId);
            },
            nextPagePosition: jest.fn(),
          };
        if (token === getQueueToken(QueueName.ATTACHMENT_QUEUE))
          return attachmentQueue;
        if (token === KYSELY_MODULE_CONNECTION_TOKEN()) return db;
        return {};
      })
      .compile();

    service = module.get<PageService>(PageService);
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  it('loads recent page metadata only after Core and local authorization', async () => {
    const candidates = Array.from({ length: 101 }, (_, index) => ({
      id: `page-${index}`,
      workspaceId: user.workspaceId,
      updatedAt: new Date(101 - index),
      deletedAt: null,
      $cursor: `cursor-${index}`,
    }));
    pageRepo.findPageListCandidates
      .mockResolvedValueOnce({
        items: candidates.slice(0, 100),
        meta: { hasNextPage: true, nextCursor: 'cursor-99' },
      })
      .mockResolvedValueOnce({
        items: candidates.slice(100),
        meta: { hasNextPage: false, nextCursor: null },
      });
    authorization.filterPages
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([candidates[100]]);
    permissions.filterAccessiblePageIds.mockResolvedValue(['page-100']);
    pageRepo.findPageListContentByIds.mockResolvedValue([
      { id: 'page-100', workspaceId: user.workspaceId, title: '允许页面' },
    ]);

    await expect(
      service.getRecentPages(user, { limit: 1 } as any),
    ).resolves.toEqual({
      items: [
        { id: 'page-100', workspaceId: user.workspaceId, title: '允许页面' },
      ],
      meta: {
        limit: 1,
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null,
        prevCursor: null,
      },
    });
    expect(pageRepo.findPageListCandidates).toHaveBeenCalledTimes(2);
    expect(permissions.filterAccessiblePageIds).toHaveBeenLastCalledWith({
      pageIds: ['page-100'],
      userId: user.id,
      spaceId: undefined,
    });
    expect(pageRepo.findPageListContentByIds).toHaveBeenCalledWith(
      ['page-100'],
      false,
    );
  });

  it('fills a logical page after more than 1000 denied candidates without repeating cursor results', async () => {
    const candidates = Array.from({ length: 1002 }, (_, index) => ({
      id: `page-${index}`,
      workspaceId: user.workspaceId,
      updatedAt: new Date(1002 - index),
      deletedAt: null,
      $cursor: `cursor-${index}`,
    }));
    pageRepo.findPageListCandidates.mockImplementation(
      async (
        _opts: unknown,
        pagination: { limit: number; cursor?: string },
      ) => {
        const start = pagination.cursor
          ? Number(pagination.cursor.replace('cursor-', '')) + 1
          : 0;
        const items = candidates.slice(start, start + pagination.limit);
        const hasNextPage = start + items.length < candidates.length;
        return {
          items,
          meta: {
            hasNextPage,
            nextCursor: hasNextPage ? items[items.length - 1]?.$cursor : null,
          },
        };
      },
    );
    authorization.filterPages.mockImplementation(async (batch: any[]) =>
      batch.filter((candidate) => Number(candidate.id.slice(5)) >= 1000),
    );
    permissions.filterAccessiblePageIds.mockImplementation(
      async ({ pageIds }: { pageIds: string[] }) => pageIds,
    );
    pageRepo.findPageListContentByIds.mockImplementation(
      async (pageIds: string[]) => pageIds.map((id) => ({ id, title: id })),
    );

    const first = await service.getRecentPages(user, { limit: 1 } as any);
    const second = await service.getRecentPages(user, {
      limit: 1,
      cursor: first.meta.nextCursor,
    } as any);

    expect(first.items.map((page) => page.id)).toEqual(['page-1000']);
    expect(first.meta.nextCursor).toBe('cursor-1000');
    expect(second.items.map((page) => page.id)).toEqual(['page-1001']);
    expect(second.meta.prevCursor).toBe('cursor-1001');
    expect(
      pageRepo.findPageListCandidates.mock.calls.every(
        ([, pagination]) => pagination.limit <= 100,
      ),
    ).toBe(true);
    expect(
      authorization.filterPages.mock.calls.every(
        ([batch]) => batch.length <= 100,
      ),
    ).toBe(true);
    expect(pageRepo.findPageListContentByIds).toHaveBeenNthCalledWith(
      1,
      ['page-1000'],
      false,
    );
    expect(pageRepo.findPageListContentByIds).toHaveBeenNthCalledWith(
      2,
      ['page-1001'],
      false,
    );
  });

  it('fills a sidebar page after more than 1000 denied candidates in bounded batches', async () => {
    const candidates = Array.from({ length: 1001 }, (_, index) => ({
      id: `sidebar-${index}`,
      workspaceId: user.workspaceId,
      position: `position-${index}`,
      $cursor: `cursor-${index}`,
    }));
    pageRepo.findSidebarCandidates.mockImplementation(
      async (
        _spaceId: string,
        _pageId: string | undefined,
        pagination: { limit: number; cursor?: string },
      ) => {
        const start = pagination.cursor
          ? Number(pagination.cursor.replace('cursor-', '')) + 1
          : 0;
        const items = candidates.slice(start, start + pagination.limit);
        const hasNextPage = start + items.length < candidates.length;
        return {
          items,
          meta: {
            hasNextPage,
            nextCursor: hasNextPage ? items[items.length - 1]?.$cursor : null,
          },
        };
      },
    );
    authorization.filterPages.mockImplementation(async (batch: any[]) =>
      batch.filter((candidate) => candidate.id === 'sidebar-1000'),
    );
    permissions.hasRestrictedPagesInSpace.mockResolvedValue(false);
    pageRepo.findSidebarContentByIds.mockResolvedValue([
      { id: 'sidebar-1000', title: '允许父页', hasChildren: false },
    ]);

    const result = await service.getSidebarPages(
      'space',
      { limit: 1 } as any,
      undefined,
      user,
      true,
    );

    expect(result.items.map((page) => page.id)).toEqual(['sidebar-1000']);
    expect(result.meta.hasNextPage).toBe(false);
    expect(
      pageRepo.findSidebarCandidates.mock.calls.every(
        ([, , pagination]) => pagination.limit <= 100,
      ),
    ).toBe(true);
    expect(
      authorization.filterPages.mock.calls.every(
        ([batch]) => batch.length <= 100,
      ),
    ).toBe(true);
    expect(pageRepo.findSidebarContentByIds).toHaveBeenCalledWith([
      'sidebar-1000',
    ]);
  });

  it('scans past 100 denied sidebar candidates before loading allowed metadata', async () => {
    const candidates = Array.from({ length: 101 }, (_, index) => ({
      id: `sidebar-${index}`,
      workspaceId: user.workspaceId,
      position: `position-${index}`,
      $cursor: `cursor-${index}`,
    }));
    pageRepo.findSidebarCandidates
      .mockResolvedValueOnce({
        items: candidates.slice(0, 100),
        meta: { hasNextPage: true, nextCursor: 'cursor-99' },
      })
      .mockResolvedValueOnce({
        items: candidates.slice(100),
        meta: { hasNextPage: false, nextCursor: null },
      });
    authorization.filterPages
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([candidates[100]]);
    permissions.hasRestrictedPagesInSpace.mockResolvedValue(false);
    pageRepo.findSidebarContentByIds.mockResolvedValue([
      { id: candidates[100].id, title: '允许父页', hasChildren: false },
    ]);

    await expect(
      service.getSidebarPages(
        'space',
        { limit: 1 } as any,
        undefined,
        user,
        true,
      ),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: candidates[100].id,
          title: '允许父页',
        }),
      ],
      meta: {
        limit: 1,
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null,
        prevCursor: null,
      },
    });
    expect(pageRepo.findSidebarCandidates).toHaveBeenCalledTimes(2);
    expect(pageRepo.findSidebarCandidates).toHaveBeenLastCalledWith(
      'space',
      undefined,
      expect.objectContaining({ cursor: 'cursor-99', limit: 100 }),
    );
    expect(pageRepo.findSidebarContentByIds).toHaveBeenCalledWith([
      candidates[100].id,
    ]);
  });

  it('checks Core immediately before queuing or physically deleting a subtree', async () => {
    const pageId = 'page';
    const descendants = [{ id: pageId }, { id: 'child' }];
    const execute = jest.fn().mockResolvedValue(descendants);
    const recursiveQuery: any = {
      selectFrom: jest.fn(),
      selectAll: jest.fn(),
      execute,
    };
    recursiveQuery.selectFrom.mockReturnValue(recursiveQuery);
    recursiveQuery.selectAll.mockReturnValue(recursiveQuery);
    db.withRecursive.mockReturnValue(recursiveQuery);
    const deleteExecute = jest.fn().mockResolvedValue(undefined);
    db.deleteFrom.mockReturnValue({
      where: jest.fn().mockReturnValue({ execute: deleteExecute }),
    });
    lifecycle.requireDeletedTree.mockResolvedValue(undefined);

    await service.forceDelete(pageId, user.workspaceId);

    expect(lifecycle.requireDeletedTree).toHaveBeenCalledWith(
      user.workspaceId,
      pageId,
      descendants,
    );
    expect(
      lifecycle.requireDeletedTree.mock.invocationCallOrder[0],
    ).toBeGreaterThan(attachmentQueue.add.mock.invocationCallOrder[1]);
    expect(
      lifecycle.requireDeletedTree.mock.invocationCallOrder[0],
    ).toBeLessThan(deleteExecute.mock.invocationCallOrder[0]);
    expect(attachmentQueue.add).toHaveBeenCalledWith(
      expect.anything(),
      { pageId, rootPageId: pageId, workspaceId: user.workspaceId },
      expect.anything(),
    );
    expect(attachmentQueue.add).toHaveBeenCalledTimes(2);
    expect(deleteExecute).toHaveBeenCalledTimes(1);
  });

  it('does not delete pages when the execution-time Core fence fails', async () => {
    const execute = jest.fn().mockResolvedValue([{ id: 'page' }]);
    const recursiveQuery: any = {
      selectFrom: jest.fn(),
      selectAll: jest.fn(),
      execute,
    };
    recursiveQuery.selectFrom.mockReturnValue(recursiveQuery);
    recursiveQuery.selectAll.mockReturnValue(recursiveQuery);
    db.withRecursive.mockReturnValue(recursiveQuery);
    lifecycle.requireDeletedTree.mockRejectedValue(
      new Error('Core unavailable'),
    );

    await expect(service.forceDelete('page', user.workspaceId)).rejects.toThrow(
      'Core unavailable',
    );
    expect(attachmentQueue.add).toHaveBeenCalledTimes(1);
    expect(db.deleteFrom).not.toHaveBeenCalled();
  });
});
