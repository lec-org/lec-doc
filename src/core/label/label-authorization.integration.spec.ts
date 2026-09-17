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
import { LabelRepo, LabelType } from '../../database/repos/label/label.repo';
import { KyselyDB } from '../../database/types/kysely.types';
import { User } from '../../database/types/entity.types';
import { LabelService } from './label.service';

const url = process.env.LEC_DOC_TEST_DATABASE_URL;

(url ? describe : describe.skip)('real PostgreSQL label authorization', () => {
  let db: KyselyDB;
  let service: LabelService;
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
    service = new LabelService(
      new LabelRepo(db, spaceMembers as any),
      local as any,
      {} as any,
      db,
      core as any,
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
      .values({ id: workspaceId, name: 'Label authorization' })
      .execute();
    await db
      .insertInto('users')
      .values({
        id: userId,
        workspaceId,
        email: `${userId}@example.test`,
        name: 'Label reader',
      })
      .execute();
    await db
      .insertInto('spaces')
      .values({
        id: spaceId,
        workspaceId,
        slug: `label-${spaceId}`,
        name: 'Label space',
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

  it('excludes denied-only labels and counts only Core then local allowed pages', async () => {
    const deniedLabelId = randomUUID();
    const visibleLabelId = randomUUID();
    const pageIds = [randomUUID(), randomUUID(), randomUUID()];
    await db
      .insertInto('labels')
      .values([
        {
          id: deniedLabelId,
          name: 'denied-label',
          type: LabelType.PAGE,
          workspaceId,
        },
        {
          id: visibleLabelId,
          name: 'visible-label',
          type: LabelType.PAGE,
          workspaceId,
        },
      ])
      .execute();
    await db
      .insertInto('pages')
      .values(
        pageIds.map((id, index) => ({
          id,
          workspaceId,
          spaceId,
          slugId: `label-page-${index}-${id}`,
          title: `Page ${index}`,
          creatorId: userId,
          lastUpdatedById: userId,
        })),
      )
      .execute();
    await db
      .insertInto('pageLabels')
      .values([
        { pageId: pageIds[0], labelId: deniedLabelId },
        { pageId: pageIds[1], labelId: visibleLabelId },
        { pageId: pageIds[2], labelId: visibleLabelId },
      ])
      .execute();
    core.filterPages.mockImplementation(async (pages: any[]) =>
      pages.filter((page) => page.id !== pageIds[0]),
    );
    local.filterAccessiblePageIds.mockImplementation(async ({ pageIds: ids }) =>
      ids.filter((id: string) => id === pageIds[2]),
    );

    const directory = await service.getLabels(user, LabelType.PAGE, {
      limit: 20,
    } as any);
    const denied = await service.getLabelInfo(
      'denied-label',
      LabelType.PAGE,
      user,
    );
    const visible = await service.getLabelInfo(
      'visible-label',
      LabelType.PAGE,
      user,
    );

    expect(directory.items.map((label) => label.name)).toEqual([
      'visible-label',
    ]);
    expect(denied).toEqual({ name: 'denied-label', usageCount: 0 });
    expect(visible).toEqual({ name: 'visible-label', usageCount: 1 });
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
