import { User } from '@docmost/db/types/entity.types';
import { SearchService } from './search.service';

const user = { id: 'user', workspaceId: 'workspace' } as User;

function query(rows: any[]) {
  const state = { limit: rows.length, offset: 0 };
  const chain: any = {
    select: jest.fn(() => chain),
    selectFrom: jest.fn(() => chain),
    where: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    $if: jest.fn((condition: boolean, apply: (query: any) => any) => {
      if (condition) apply(chain);
      return chain;
    }),
    limit: jest.fn((limit: number) => {
      state.limit = limit;
      return chain;
    }),
    offset: jest.fn((offset: number) => {
      state.offset = offset;
      return chain;
    }),
    execute: jest.fn(async () =>
      rows.slice(state.offset, state.offset + state.limit),
    ),
  };
  return chain;
}

describe('SearchService authorization scanning', () => {
  it('scans beyond 1000 denied candidates in bounded batches before loading content', async () => {
    const candidates = Array.from({ length: 1101 }, (_, index) => ({
      id: `page-${index}`,
      workspaceId: user.workspaceId,
      rank: 1001 - index,
    }));
    const candidateQuery = query(candidates);
    const contentQuery = query([
      { id: 'page-1000', title: 'allowed', textContent: 'needle' },
    ]);
    const db = {
      selectFrom: jest
        .fn()
        .mockReturnValueOnce(candidateQuery)
        .mockReturnValueOnce(contentQuery),
    };
    const core = {
      filterPages: jest.fn(async (batch: any[]) =>
        batch.filter((candidate) => candidate.id === 'page-1000'),
      ),
    };
    const local = {
      filterAccessiblePageIds: jest.fn(
        async ({ pageIds }: { pageIds: string[] }) => pageIds,
      ),
    };
    const service = new SearchService(
      db as any,
      { withSpace: jest.fn() } as any,
      {} as any,
      { getUserSpaceIdsQuery: jest.fn() } as any,
      local as any,
      core as any,
    );

    const result = await service.searchPage(
      { query: 'needle', limit: 1 },
      { user, workspaceId: user.workspaceId },
    );

    expect(result.items.map((page) => page.id)).toEqual(['page-1000']);
    expect(
      candidateQuery.limit.mock.calls.every(([limit]) => limit <= 100),
    ).toBe(true);
    expect(core.filterPages).toHaveBeenCalledTimes(12);
    expect(
      core.filterPages.mock.calls.every(([batch]) => batch.length <= 100),
    ).toBe(true);
    expect(contentQuery.where).toHaveBeenCalledWith('id', 'in', ['page-1000']);
  });

  it('scans page suggestions beyond 1000 denied candidates in bounded batches', async () => {
    const candidates = Array.from({ length: 1101 }, (_, index) => ({
      id: `page-${index}`,
      workspaceId: user.workspaceId,
    }));
    const candidateQuery = query(candidates);
    const contentQuery = query([{ id: 'page-1000', title: 'allowed' }]);
    const db = {
      selectFrom: jest
        .fn()
        .mockReturnValueOnce(candidateQuery)
        .mockReturnValueOnce(contentQuery),
    };
    const core = {
      filterPages: jest.fn(async (batch: any[]) =>
        batch.filter((candidate) => candidate.id === 'page-1000'),
      ),
    };
    const local = {
      filterAccessiblePageIds: jest.fn(
        async ({ pageIds }: { pageIds: string[] }) => pageIds,
      ),
    };
    const service = new SearchService(
      db as any,
      { withSpace: jest.fn() } as any,
      {} as any,
      { getUserSpaceIds: jest.fn().mockResolvedValue(['space']) } as any,
      local as any,
      core as any,
    );

    const result = await service.searchSuggestions(
      { query: 'allowed', includePages: true, limit: 1 },
      user,
      user.workspaceId,
    );

    expect(result.pages.map((page: any) => page.id)).toEqual(['page-1000']);
    expect(
      candidateQuery.limit.mock.calls.every(([limit]) => limit <= 100),
    ).toBe(true);
    expect(core.filterPages).toHaveBeenCalledTimes(12);
    expect(
      core.filterPages.mock.calls.every(([batch]) => batch.length <= 100),
    ).toBe(true);
    expect(contentQuery.where).toHaveBeenCalledWith('id', 'in', ['page-1000']);
  });
});
