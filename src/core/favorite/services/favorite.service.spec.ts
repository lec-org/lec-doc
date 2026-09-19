jest.mock('uuid', () => ({
  v7: jest.fn(),
  validate: jest.fn(() => true),
}));
jest.mock('nanoid', () => ({
  customAlphabet: jest.fn(() => jest.fn()),
}));

import { User } from '@docmost/db/types/entity.types';
import { FavoriteType } from '@docmost/db/repos/favorite/favorite.repo';
import { FavoriteService } from './favorite.service';

const user = { id: 'user', workspaceId: 'workspace' } as User;

describe('FavoriteService', () => {
  it('never passes Core-denied page favorites to local permission filtering', async () => {
    const favorites = {
      findFavoriteIdCandidates: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'favorite-allowed',
            entityId: 'allowed',
            workspaceId: user.workspaceId,
            $cursor: 'cursor-allowed',
          },
          {
            id: 'favorite-denied',
            entityId: 'denied',
            workspaceId: user.workspaceId,
            $cursor: 'cursor-denied',
          },
        ],
        meta: { hasNextPage: false, nextCursor: null },
      }),
    };
    const core = {
      filterPages: jest.fn().mockResolvedValue([
        { id: 'allowed', workspaceId: 'workspace' },
      ]),
    };
    const local = {
      filterAccessiblePageIds: jest.fn().mockResolvedValue(['allowed']),
    };
    const service = new FavoriteService(
      favorites as any,
      local as any,
      core as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.getFavoriteIds(user, user.workspaceId, FavoriteType.PAGE),
    ).resolves.toEqual({
      items: ['allowed'],
      meta: {
        limit: 250,
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null,
        prevCursor: null,
      },
    });
    expect(local.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: ['allowed'],
      userId: user.id,
    });
    expect(core.filterPages.mock.invocationCallOrder[0]).toBeLessThan(
      local.filterAccessiblePageIds.mock.invocationCallOrder[0],
    );
  });

  it('scans favorite IDs past 100 Core-denied pages with the candidate cursor', async () => {
    const candidates = Array.from({ length: 101 }, (_, index) => ({
      id: `favorite-${index}`,
      entityId: `page-${index}`,
      workspaceId: user.workspaceId,
      $cursor: `cursor-${index}`,
    }));
    const favorites = {
      findFavoriteIdCandidates: jest
        .fn()
        .mockResolvedValueOnce({
          items: candidates.slice(0, 100),
          meta: { hasNextPage: true, nextCursor: 'next-100' },
        })
        .mockResolvedValueOnce({
          items: candidates.slice(100),
          meta: { hasNextPage: false, nextCursor: null },
        }),
    };
    const core = {
      filterPages: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'page-100', workspaceId: user.workspaceId },
        ]),
    };
    const local = {
      filterAccessiblePageIds: jest.fn().mockResolvedValue(['page-100']),
    };
    const service = new FavoriteService(
      favorites as any,
      local as any,
      core as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.getFavoriteIds(user, user.workspaceId, FavoriteType.PAGE),
    ).resolves.toEqual({
      items: ['page-100'],
      meta: {
        limit: 250,
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null,
        prevCursor: null,
      },
    });
    expect(favorites.findFavoriteIdCandidates).toHaveBeenCalledTimes(2);
    expect(favorites.findFavoriteIdCandidates).toHaveBeenNthCalledWith(
      1,
      user.id,
      user.workspaceId,
      FavoriteType.PAGE,
      undefined,
      expect.objectContaining({ limit: 100, cursor: undefined }),
    );
    expect(favorites.findFavoriteIdCandidates).toHaveBeenNthCalledWith(
      2,
      user.id,
      user.workspaceId,
      FavoriteType.PAGE,
      undefined,
      expect.objectContaining({ limit: 100, cursor: 'next-100' }),
    );
    expect(local.filterAccessiblePageIds).toHaveBeenCalledTimes(1);
    expect(core.filterPages.mock.calls[0][0]).toHaveLength(100);
    expect(local.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: ['page-100'],
      userId: user.id,
    });
    expect(core.filterPages.mock.invocationCallOrder[1]).toBeLessThan(
      local.filterAccessiblePageIds.mock.invocationCallOrder[0],
    );
  });

  it('scans past 1000 Core-denied favorite IDs to an allowed result', async () => {
    const candidates = Array.from({ length: 1001 }, (_, index) => ({
      id: `favorite-${index}`,
      entityId: `page-${index}`,
      workspaceId: user.workspaceId,
      $cursor: `cursor-${index}`,
    }));
    const findFavoriteIdCandidates = jest.fn();
    for (let offset = 0; offset < candidates.length; offset += 100) {
      const end = Math.min(offset + 100, candidates.length);
      findFavoriteIdCandidates.mockResolvedValueOnce({
        items: candidates.slice(offset, end),
        meta: {
          hasNextPage: end < candidates.length,
          nextCursor: end < candidates.length ? `next-${end}` : null,
        },
      });
    }
    const core = {
      filterPages: jest.fn(async (pages: any[]) =>
        pages.filter((page) => page.id === 'page-1000'),
      ),
    };
    const local = {
      filterAccessiblePageIds: jest.fn(async ({ pageIds }: any) => pageIds),
    };
    const service = new FavoriteService(
      { findFavoriteIdCandidates } as any,
      local as any,
      core as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.getFavoriteIds(user, user.workspaceId, FavoriteType.PAGE),
    ).resolves.toEqual({
      items: ['page-1000'],
      meta: {
        limit: 250,
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null,
        prevCursor: null,
      },
    });
    expect(findFavoriteIdCandidates).toHaveBeenCalledTimes(11);
    expect(findFavoriteIdCandidates).toHaveBeenLastCalledWith(
      user.id,
      user.workspaceId,
      FavoriteType.PAGE,
      undefined,
      expect.objectContaining({ limit: 100, cursor: 'next-1000' }),
    );
    expect(core.filterPages).toHaveBeenCalledTimes(11);
    expect(
      core.filterPages.mock.calls.every(([pages]) => pages.length <= 100),
    ).toBe(true);
  });

  it('filters space favorite IDs through Core SPACE VIEW', async () => {
    const favorites = {
      findFavoriteIdCandidates: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'favorite-allowed',
            entityId: 'allowed',
            workspaceId: user.workspaceId,
            $cursor: 'cursor-allowed',
          },
          {
            id: 'favorite-denied',
            entityId: 'denied',
            workspaceId: user.workspaceId,
            $cursor: 'cursor-denied',
          },
        ],
        meta: { hasNextPage: false, nextCursor: null },
      }),
    };
    const core = {
      filterSpaces: jest.fn().mockResolvedValue([
        { id: 'allowed', workspaceId: user.workspaceId },
      ]),
    };
    const service = new FavoriteService(
      favorites as any,
      {} as any,
      core as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.getFavoriteIds(user, user.workspaceId, FavoriteType.SPACE),
    ).resolves.toEqual({
      items: ['allowed'],
      meta: {
        limit: 250,
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null,
        prevCursor: null,
      },
    });
    expect(core.filterSpaces).toHaveBeenCalledWith(
      [
        { id: 'allowed', workspaceId: user.workspaceId },
        { id: 'denied', workspaceId: user.workspaceId },
      ],
      user,
    );
  });

  it('caps favorite IDs at 250 authorized results and returns that result cursor', async () => {
    const candidates = Array.from({ length: 300 }, (_, index) => ({
      id: `favorite-${index}`,
      entityId: `space-${index}`,
      workspaceId: user.workspaceId,
      $cursor: `cursor-${index}`,
    }));
    const favorites = {
      findFavoriteIdCandidates: jest
        .fn()
        .mockResolvedValueOnce({
          items: candidates.slice(0, 100),
          meta: { hasNextPage: true, nextCursor: 'next-100' },
        })
        .mockResolvedValueOnce({
          items: candidates.slice(100, 200),
          meta: { hasNextPage: true, nextCursor: 'next-200' },
        })
        .mockResolvedValueOnce({
          items: candidates.slice(200),
          meta: { hasNextPage: false, nextCursor: null },
        }),
    };
    const service = new FavoriteService(
      favorites as any,
      {} as any,
      { filterSpaces: jest.fn(async (spaces: any[]) => spaces) } as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.getFavoriteIds(
      user,
      user.workspaceId,
      FavoriteType.SPACE,
    );

    expect(result.items).toHaveLength(250);
    expect(result.items[result.items.length - 1]).toBe('space-249');
    expect(result.meta).toEqual({
      limit: 250,
      hasNextPage: true,
      hasPrevPage: false,
      nextCursor: 'cursor-249',
      prevCursor: null,
    });
    expect(favorites.findFavoriteIdCandidates).toHaveBeenCalledTimes(3);
  });

  it('scans past 100 denied page favorites before loading allowed metadata', async () => {
    const candidates = Array.from({ length: 101 }, (_, index) => ({
      id: `favorite-${index}`,
      type: FavoriteType.PAGE,
      pageId: `page-${index}`,
      workspaceId: user.workspaceId,
      $cursor: `cursor-${index}`,
    }));
    const favorites = {
      findUserFavoriteCandidates: jest
        .fn()
        .mockResolvedValueOnce({
          items: candidates.slice(0, 100),
          meta: { hasNextPage: true, nextCursor: 'cursor-99' },
        })
        .mockResolvedValueOnce({
          items: candidates.slice(100),
          meta: { hasNextPage: false, nextCursor: null },
        }),
      findUserFavoriteContentByIds: jest.fn().mockResolvedValue([
        {
          id: 'favorite-100',
          type: FavoriteType.PAGE,
          pageId: 'page-100',
          page: { id: 'page-100', title: '允许页面' },
        },
      ]),
    };
    const core = {
      filterPages: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'page-100', workspaceId: user.workspaceId },
        ]),
    };
    const local = {
      filterAccessiblePageIds: jest.fn().mockResolvedValue(['page-100']),
    };
    const service = new FavoriteService(
      favorites as any,
      local as any,
      core as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.getUserFavorites(
        user,
        user.workspaceId,
        { limit: 1 } as any,
        FavoriteType.PAGE,
      ),
    ).resolves.toEqual({
      items: [
        {
          id: 'favorite-100',
          type: FavoriteType.PAGE,
          pageId: 'page-100',
          page: { id: 'page-100', title: '允许页面' },
        },
      ],
      meta: {
        limit: 1,
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null,
        prevCursor: null,
      },
    });
    expect(favorites.findUserFavoriteCandidates).toHaveBeenCalledTimes(2);
    expect(local.filterAccessiblePageIds).toHaveBeenLastCalledWith({
      pageIds: ['page-100'],
      userId: user.id,
    });
    expect(favorites.findUserFavoriteContentByIds).toHaveBeenCalledWith(
      ['favorite-100'],
      FavoriteType.PAGE,
    );
  });

  it('filters hydrated space favorites through Core before loading metadata', async () => {
    const favorites = {
      findUserFavoriteCandidates: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'favorite-allowed',
            type: FavoriteType.SPACE,
            pageId: null,
            spaceId: 'allowed',
            workspaceId: user.workspaceId,
            $cursor: 'cursor-allowed',
          },
          {
            id: 'favorite-denied',
            type: FavoriteType.SPACE,
            pageId: null,
            spaceId: 'denied',
            workspaceId: user.workspaceId,
            $cursor: 'cursor-denied',
          },
        ],
        meta: { hasNextPage: false, nextCursor: null },
      }),
      findUserFavoriteContentByIds: jest.fn().mockResolvedValue([
        { id: 'favorite-allowed', spaceId: 'allowed' },
      ]),
    };
    const core = {
      filterPages: jest.fn().mockResolvedValue([]),
      filterSpaces: jest.fn().mockResolvedValue([
        { id: 'allowed', workspaceId: user.workspaceId },
      ]),
    };
    const service = new FavoriteService(
      favorites as any,
      { filterAccessiblePageIds: jest.fn().mockResolvedValue([]) } as any,
      core as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.getUserFavorites(
        user,
        user.workspaceId,
        { limit: 10 } as any,
        FavoriteType.SPACE,
      ),
    ).resolves.toMatchObject({
      items: [{ id: 'favorite-allowed', spaceId: 'allowed' }],
    });
    expect(favorites.findUserFavoriteContentByIds).toHaveBeenCalledWith(
      ['favorite-allowed'],
      FavoriteType.SPACE,
    );
  });

  it('notifies the page creator only for a first-time page favorite', async () => {
    const inserted = { id: 'favorite' };
    const favorites = { insert: jest.fn().mockResolvedValue(inserted) };
    const notifications = {
      create: jest.fn().mockResolvedValue({ id: 'notice', userId: 'owner', type: 'page.favorited' }),
      publish: jest.fn(),
    };
    const pages = {
      findAuthorizationSubject: jest.fn().mockResolvedValue({
        id: 'page',
        creatorId: 'owner',
        spaceId: 'space',
      }),
    };
    const trx = {};
    const db = { transaction: () => ({ execute: (fn: any) => fn(trx) }) };
    const service = new FavoriteService(
      favorites as any,
      {} as any,
      {} as any,
      notifications as any,
      pages as any,
      db as any,
    );

    await service.addFavorite('actor', 'workspace', {
      type: FavoriteType.PAGE,
      pageId: 'page',
    });

    expect(notifications.create).toHaveBeenCalledWith(
      {
        userId: 'owner',
        workspaceId: 'workspace',
        type: 'page.favorited',
        actorId: 'actor',
        pageId: 'page',
        spaceId: 'space',
      },
      trx,
    );
    favorites.insert.mockResolvedValueOnce(undefined);
    await service.addFavorite('actor', 'workspace', {
      type: FavoriteType.PAGE,
      pageId: 'page',
    });
    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(notifications.publish).toHaveBeenCalledTimes(1);
  });
});
