jest.mock('uuid', () => ({
  v7: jest.fn(),
  validate: jest.fn(() => true),
}));
jest.mock('nanoid', () => ({
  customAlphabet: jest.fn(() => jest.fn()),
}));

import { randomUUID } from 'node:crypto';
import { CamelCasePlugin, Dialect, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres = require('postgres');
import {
  FavoriteRepo,
  FavoriteType,
} from '../../database/repos/favorite/favorite.repo';
import { KyselyDB } from '../../database/types/kysely.types';
import { User } from '../../database/types/entity.types';
import { FavoriteService } from './services/favorite.service';

const url = process.env.LEC_DOC_TEST_DATABASE_URL;

function orderedUuid(value: number): string {
  const hex = value.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

(url ? describe : describe.skip)('real PostgreSQL favorite authorization', () => {
  let db: KyselyDB;
  let service: FavoriteService;
  let workspaceId: string;
  let spaceId: string;
  let userId: string;
  let user: User;
  const core = { filterPages: jest.fn() };
  const local = { filterAccessiblePageIds: jest.fn() };

  beforeAll(() => {
    db = new Kysely({
      dialect: new PostgresJSDialect({
        postgres: postgres(url, { max: 4 }),
      }) as unknown as Dialect,
      plugins: [new CamelCasePlugin()],
    });
    const spaceMembers = {
      getUserSpaceIdsQuery: () =>
        db
          .selectFrom('spaceMembers')
          .select('spaceId')
          .where('userId', '=', userId),
    };
    service = new FavoriteService(
      new FavoriteRepo(db, spaceMembers as any),
      local as any,
      core as any,
      {} as any,
      {} as any,
      db,
    );
  });

  beforeEach(async () => {
    jest.resetAllMocks();
    workspaceId = randomUUID();
    spaceId = randomUUID();
    userId = randomUUID();
    user = { id: userId, workspaceId } as User;
    await db
      .insertInto('workspaces')
      .values({ id: workspaceId, name: 'Favorite authorization' })
      .execute();
    await db
      .insertInto('users')
      .values({
        id: userId,
        workspaceId,
        email: `${userId}@example.test`,
        name: 'Favorite reader',
      })
      .execute();
    await db
      .insertInto('spaces')
      .values({
        id: spaceId,
        workspaceId,
        slug: `favorite-${spaceId}`,
        name: 'Favorite space',
      })
      .execute();
    await db
      .insertInto('spaceMembers')
      .values({ id: randomUUID(), spaceId, userId, role: 'member' })
      .execute();
  });

  afterEach(async () => {
    await db.deleteFrom('workspaces').where('id', '=', workspaceId).execute();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('scans 1000 denied rows in bounded batches and returns the next allowed ID', async () => {
    const pageIds = Array.from({ length: 1001 }, (_, index) =>
      orderedUuid(index + 2000),
    );
    await db
      .insertInto('pages')
      .values(
        pageIds.map((id, index) => ({
          id,
          workspaceId,
          spaceId,
          slugId: `favorite-page-${index}-${id}`,
          title: `Page ${index}`,
          creatorId: userId,
          lastUpdatedById: userId,
        })),
      )
      .execute();
    await db
      .insertInto('favorites')
      .values(
        pageIds.map((pageId, index) => ({
          id: orderedUuid(1001 - index),
          userId,
          pageId,
          type: FavoriteType.PAGE,
          workspaceId,
        })),
      )
      .execute();
    const allowedPageId = pageIds[1000];
    core.filterPages.mockImplementation(async (pages: any[]) =>
      pages.filter((page) => page.id === allowedPageId),
    );
    local.filterAccessiblePageIds.mockImplementation(async ({ pageIds: ids }) =>
      ids,
    );

    const result = await service.getFavoriteIds(
      user,
      workspaceId,
      FavoriteType.PAGE,
    );

    expect(result.items).toEqual([allowedPageId]);
    expect(core.filterPages).toHaveBeenCalledTimes(11);
    for (const call of core.filterPages.mock.calls) {
      const pages = call[0] as any[];
      expect(pages.length).toBeLessThanOrEqual(100);
      expect(
        pages.every(
          (page: any) =>
            Object.keys(page).sort().join(',') === 'id,workspaceId',
        ),
      ).toBe(true);
    }
  });
});
