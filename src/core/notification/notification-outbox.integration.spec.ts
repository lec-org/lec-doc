import { randomUUID } from 'node:crypto';
import { CamelCasePlugin, Dialect, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres = require('postgres');
import { KyselyDB } from '../../database/types/kysely.types';
import { FavoriteRepo, FavoriteType } from '../../database/repos/favorite/favorite.repo';
import { NotificationRepo } from '../../database/repos/notification/notification.repo';
import { PageLikeRepo } from '../../database/repos/page-like/page-like.repo';
import { PageRepo } from '../../database/repos/page/page.repo';
import { UserRepo } from '../../database/repos/user/user.repo';
import { FavoriteService } from '../favorite/services/favorite.service';
import { PageLikeService } from '../page-like/page-like.service';
import { NotificationType } from './notification.constants';
import { NotificationService } from './notification.service';

const url = process.env.LEC_DOC_TEST_DATABASE_URL;

(url ? describe : describe.skip)('真实 PostgreSQL 文档操作通知 outbox', () => {
  let db: KyselyDB;
  let workspaceId: string;
  let spaceId: string;
  let pageId: string;
  let ownerId: string;
  let actorId: string;
  let notifications: NotificationService;

  beforeAll(() => {
    db = new Kysely({
      dialect: new PostgresJSDialect({
        postgres: postgres(url, { max: 4 }),
      }) as unknown as Dialect,
      plugins: [new CamelCasePlugin()],
    });
    const repo = new NotificationRepo(db, {} as any);
    notifications = new NotificationService(
      repo,
      {} as any,
      { server: { to: () => ({ emit: () => undefined }) } } as any,
      {} as any,
      db,
      {} as any,
      new UserRepo(db),
      { validateCanView: jest.fn().mockResolvedValue(undefined) } as any,
    );
  });

  beforeEach(async () => {
    workspaceId = randomUUID();
    spaceId = randomUUID();
    pageId = randomUUID();
    ownerId = randomUUID();
    actorId = randomUUID();
    await db.insertInto('workspaces').values({ id: workspaceId, name: '通知事务测试' }).execute();
    await db.insertInto('users').values([
      { id: ownerId, workspaceId, email: `${ownerId}@example.test`, name: '文档创建者' },
      { id: actorId, workspaceId, email: `${actorId}@example.test`, name: '操作用户' },
    ]).execute();
    await db.insertInto('spaces').values({
      id: spaceId,
      workspaceId,
      creatorId: ownerId,
      slug: `notice-${spaceId}`,
      name: '通知空间',
    }).execute();
    await db.insertInto('pages').values({
      id: pageId,
      workspaceId,
      spaceId,
      slugId: `notice-${pageId}`,
      title: '绝不进入机器人消息的机密标题',
      creatorId: ownerId,
      lastUpdatedById: ownerId,
    }).execute();
  });

  afterEach(async () => {
    await db.deleteFrom('workspaces').where('id', '=', workspaceId).execute();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('相同通知事件 ID 重放时复用原通知及 IM intent', async () => {
    const id = randomUUID();
    const command = {
      id,
      userId: ownerId,
      workspaceId,
      type: NotificationType.PAGE_PERMISSION_GRANTED,
      actorId,
      pageId,
      spaceId,
      data: { role: 'reader' },
    };

    const first = await notifications.create(command);
    const replay = await notifications.create(command);

    expect(replay?.id).toBe(first?.id);
    expect(
      await db
        .selectFrom('notifications')
        .select('id')
        .where('id', '=', id)
        .execute(),
    ).toHaveLength(1);
    expect(
      await db
        .selectFrom('lecDocumentNotificationOutbox')
        .select('notificationId')
        .where('notificationId', '=', id)
        .execute(),
    ).toHaveLength(1);
  });

  it('首次收藏和点赞各产生一个站内通知及同事务 IM intent，重复操作不重复', async () => {
    const pageRepo = new PageRepo(db, {} as any, { emit: jest.fn() } as any);
    const favorite = new FavoriteService(
      new FavoriteRepo(db, {} as any),
      {} as any,
      {} as any,
      notifications,
      pageRepo,
      db,
    );
    const like = new PageLikeService(new PageLikeRepo(db), notifications, db);
    const actor = { id: actorId, workspaceId } as any;
    const page = await pageRepo.findById(pageId);

    await favorite.addFavorite(actorId, workspaceId, { type: FavoriteType.PAGE, pageId });
    await favorite.addFavorite(actorId, workspaceId, { type: FavoriteType.PAGE, pageId });
    await like.like(actor, page);
    await like.like(actor, page);

    const native = await db
      .selectFrom('notifications')
      .select(['id', 'type', 'userId'])
      .where('workspaceId', '=', workspaceId)
      .where('type', 'in', [NotificationType.PAGE_FAVORITED, NotificationType.PAGE_LIKED])
      .execute();
    expect(native).toHaveLength(2);
    expect(new Set(native.map((row) => row.type))).toEqual(
      new Set([NotificationType.PAGE_FAVORITED, NotificationType.PAGE_LIKED]),
    );
    expect(native.every((row) => row.userId === ownerId)).toBe(true);

    const intents = await db
      .selectFrom('lecDocumentNotificationOutbox')
      .select('notificationId')
      .where('notificationId', 'in', native.map((row) => row.id))
      .execute();
    expect(intents).toHaveLength(2);
    expect(await db.selectFrom('pageLikes').select('id').where('pageId', '=', pageId).execute()).toHaveLength(1);
  });

  it('IM intent 写入失败时收藏和站内通知一起回滚', async () => {
    await sql`
      CREATE OR REPLACE FUNCTION test_reject_doc_notification_outbox()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM notifications
          WHERE id = NEW.notification_id AND type = 'page.favorited'
        ) THEN
          RAISE EXCEPTION 'injected outbox failure';
        END IF;
        RETURN NEW;
      END $$
    `.execute(db);
    await sql`
      CREATE TRIGGER test_reject_doc_notification_outbox
      BEFORE INSERT ON lec_document_notification_outbox
      FOR EACH ROW EXECUTE FUNCTION test_reject_doc_notification_outbox()
    `.execute(db);

    try {
      const pageRepo = new PageRepo(db, {} as any, { emit: jest.fn() } as any);
      const favorite = new FavoriteService(
        new FavoriteRepo(db, {} as any),
        {} as any,
        {} as any,
        notifications,
        pageRepo,
        db,
      );
      await expect(
        favorite.addFavorite(actorId, workspaceId, {
          type: FavoriteType.PAGE,
          pageId,
        }),
      ).rejects.toThrow('injected outbox failure');
      const [native, business] = await Promise.all([
        db
          .selectFrom('notifications')
          .select('id')
          .where('workspaceId', '=', workspaceId)
          .where('type', '=', NotificationType.PAGE_FAVORITED)
          .executeTakeFirst(),
        db
          .selectFrom('favorites')
          .select('id')
          .where('userId', '=', actorId)
          .where('pageId', '=', pageId)
          .executeTakeFirst(),
      ]);
      expect(native).toBeUndefined();
      expect(business).toBeUndefined();
    } finally {
      await sql`DROP TRIGGER IF EXISTS test_reject_doc_notification_outbox ON lec_document_notification_outbox`.execute(db);
      await sql`DROP FUNCTION IF EXISTS test_reject_doc_notification_outbox()`.execute(db);
    }
  });
});
