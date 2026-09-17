import { randomUUID } from 'node:crypto';
import { CamelCasePlugin, Dialect, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres = require('postgres');
import { KyselyDB } from '../../database/types/kysely.types';
import { NotificationRepo } from '../../database/repos/notification/notification.repo';
import { NotificationService } from './notification.service';

const url = process.env.LEC_DOC_TEST_DATABASE_URL;

(url ? describe : describe.skip)('真实 PostgreSQL 通知授权分页', () => {
  const db: KyselyDB = new Kysely({
    dialect: new PostgresJSDialect({
      postgres: postgres(url, { max: 4 }),
    }) as unknown as Dialect,
    plugins: [new CamelCasePlugin()],
  });
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  const deniedPageId = randomUUID();
  const allowedPageId = randomUUID();
  const user = { id: userId, workspaceId } as any;

  beforeAll(async () => {
    await db
      .insertInto('workspaces')
      .values({
        id: workspaceId,
        name: 'Notification paging',
        hostname: `notice-${workspaceId}`,
      })
      .execute();
    await db
      .insertInto('users')
      .values({
        id: userId,
        workspaceId,
        name: 'Reader',
        email: `${userId}@example.test`,
      })
      .execute();
    await db
      .insertInto('spaces')
      .values({
        id: spaceId,
        workspaceId,
        creatorId: userId,
        slug: `notice-${spaceId}`,
        name: 'Notice space',
      })
      .execute();
    await db
      .insertInto('pages')
      .values([
        {
          id: deniedPageId,
          workspaceId,
          spaceId,
          slugId: `denied-${deniedPageId}`,
          title: 'Denied',
          creatorId: userId,
          lastUpdatedById: userId,
        },
        {
          id: allowedPageId,
          workspaceId,
          spaceId,
          slugId: `allowed-${allowedPageId}`,
          title: 'Allowed',
          creatorId: userId,
          lastUpdatedById: userId,
        },
      ])
      .execute();
    await db
      .insertInto('notifications')
      .values([
        {
          userId,
          workspaceId,
          type: 'page.updated',
          pageId: deniedPageId,
          spaceId,
        },
        {
          userId,
          workspaceId,
          type: 'page.updated',
          pageId: allowedPageId,
          spaceId,
        },
      ])
      .execute();
  });

  afterAll(async () => {
    await db.deleteFrom('workspaces').where('id', '=', workspaceId).execute();
    await db.destroy();
  });

  function service(core: { filterPages: jest.Mock }) {
    const spaceMembers = {
      getUserSpaceIdsQuery: () =>
        db.selectFrom('spaces').select('id').where('id', '=', spaceId),
    };
    return new NotificationService(
      new NotificationRepo(db, spaceMembers as any),
      {
        filterAccessiblePageIds: jest.fn(async ({ pageIds }) => pageIds),
      } as any,
      {} as any,
      {} as any,
      db,
      core as any,
      {} as any,
      {} as any,
    );
  }

  it('候选页先过滤 Core VIEW，再返回完整一页且未读计数不泄露拒绝项', async () => {
    const notificationService = service({
      filterPages: jest.fn(async (pages) =>
        pages.filter((page) => page.id === allowedPageId),
      ),
    });

    const result = await notificationService.findByUserId(user, {
      limit: 1,
    } as any);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].pageId).toBe(allowedPageId);
    await expect(notificationService.getUnreadCount(user)).resolves.toBe(1);
  });

  it('mark-all-read 只更新当前 Core VIEW 允许的候选通知', async () => {
    const notificationService = service({
      filterPages: jest.fn(async (pages) =>
        pages.filter((page) => page.id === allowedPageId),
      ),
    });

    await notificationService.markAllAsRead(user);

    const notifications = await db
      .selectFrom('notifications')
      .select(['pageId', 'readAt'])
      .where('userId', '=', userId)
      .execute();
    const readAtByPage = new Map(
      notifications.map((notification) => [
        notification.pageId,
        notification.readAt,
      ]),
    );
    expect(readAtByPage.get(allowedPageId)).not.toBeNull();
    expect(readAtByPage.get(deniedPageId)).toBeNull();
  });
});
