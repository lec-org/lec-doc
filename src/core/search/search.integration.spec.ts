import { CamelCasePlugin, Dialect, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres = require('postgres');
import { randomUUID } from 'node:crypto';
import { KyselyDB } from '../../database/types/kysely.types';
import { User } from '../../database/types/entity.types';
import { PageRepo } from '../../database/repos/page/page.repo';
import { SearchService } from './search.service';

const url = process.env.LEC_DOC_TEST_DATABASE_URL;

(url ? describe : describe.skip)('真实 PostgreSQL 授权感知搜索', () => {
  let db: KyselyDB;
  let service: SearchService;
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
    const pageRepo = new PageRepo(
      db,
      {} as any,
      { emit: jest.fn() } as any,
    );
    service = new SearchService(
      db,
      pageRepo,
      {} as any,
      {
        getUserSpaceIdsQuery: () =>
          db
            .selectFrom('spaceMembers')
            .select('spaceId')
            .where('userId', '=', userId),
        getUserSpaceIds: async () => [spaceId],
      } as any,
      local as any,
      core as any,
    );
  });

  beforeEach(async () => {
    jest.resetAllMocks();
    workspaceId = randomUUID();
    spaceId = randomUUID();
    userId = randomUUID();
    user = { id: userId, workspaceId } as User;
    await db.insertInto('workspaces').values({ id: workspaceId, name: '搜索测试' }).execute();
    await db.insertInto('users').values({
      id: userId,
      workspaceId,
      email: `${userId}@example.test`,
      name: '搜索用户',
    }).execute();
    await db.insertInto('spaces').values({
      id: spaceId,
      workspaceId,
      slug: `space-${spaceId}`,
      name: '搜索空间',
    }).execute();
    await db.insertInto('spaceMembers').values({
      id: randomUUID(),
      spaceId,
      userId,
      role: 'member',
    }).execute();
  });

  afterEach(async () => {
    await db.deleteFrom('workspaces').where('id', '=', workspaceId).execute();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('中文标题和正文候选先经 Core 授权，再加载敏感字段并继续扫描填满页面', async () => {
    const deniedIds: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const id = randomUUID();
      if (index < 100) deniedIds.push(id);
      await db.insertInto('pages').values({
        id,
        workspaceId,
        spaceId,
        slugId: `page-${index}-${id}`,
        title: index === 100 ? '中文标题允许' : `机密标题-${index}`,
        textContent: index === 100 ? '正文包含中文关键字' : '中文关键字',
        creatorId: userId,
        lastUpdatedById: userId,
      }).execute();
    }
    core.filterPages.mockImplementation(async (pages: any[]) =>
      pages.filter((page) => !deniedIds.includes(page.id)),
    );
    local.filterAccessiblePageIds.mockImplementation(async ({ pageIds }: any) => pageIds);

    const result = await service.searchPage(
      { query: '中文关键字', limit: 1 },
      { user, workspaceId },
    );

    expect(core.filterPages).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual(
      expect.objectContaining({ title: '中文标题允许' }),
    );
    expect(result.items[0].highlight).toContain('<b>中文关键字</b>');
    for (const [candidates] of core.filterPages.mock.calls) {
      expect(candidates.every((page: any) => Object.keys(page).sort().join(',') === 'id,rank,workspaceId')).toBe(true);
    }
    expect(JSON.stringify(result.items)).not.toContain('机密标题');
  });

  it('建议列表不会在 Core 授权前读取标题，并在首批全拒绝后继续扫描', async () => {
    await db.insertInto('pages').values(
      Array.from({ length: 101 }, (_, index) => ({
        id: randomUUID(),
        workspaceId,
        spaceId,
        slugId: `suggestion-${index}-${randomUUID()}`,
        title: `建议中文-${index}`,
        textContent: '不应提前加载',
        creatorId: userId,
        lastUpdatedById: userId,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      })),
    ).execute();
    core.filterPages
      .mockResolvedValueOnce([])
      .mockImplementation(async (pages: any[]) => pages);
    local.filterAccessiblePageIds.mockImplementation(async ({ pageIds }: any) => pageIds);

    const result = await service.searchSuggestions(
      { query: '建议中文', includePages: true, limit: 1 },
      user,
      workspaceId,
    );

    expect(core.filterPages).toHaveBeenCalledTimes(2);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].title).toContain('建议中文');
    for (const [candidates] of core.filterPages.mock.calls) {
      expect(candidates.every((page: any) => !('title' in page) && !('icon' in page) && !('space' in page))).toBe(true);
    }
  });
});
