import { randomUUID } from 'node:crypto';
import { CamelCasePlugin, Dialect, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres = require('postgres');
import { KyselyDB } from '../../database/types/kysely.types';
import { NotificationRepo } from '../../database/repos/notification/notification.repo';
import { UserRepo } from '../../database/repos/user/user.repo';
import { NotificationService } from '../notification/notification.service';
import { LecPageControlService } from './lec-page-control.service';

const url = process.env.LEC_DOC_TEST_DATABASE_URL;

(url ? describe : describe.skip)('真实 PostgreSQL 页面 VIEW grant 控制 intent', () => {
  const db: KyselyDB = new Kysely({
    dialect: new PostgresJSDialect({
      postgres: postgres(url, { max: 4 }),
    }) as unknown as Dialect,
    plugins: [new CamelCasePlugin()],
  });
  const workspaceId = randomUUID();
  const actorId = randomUUID();
  const recipientId = randomUUID();
  const spaceId = randomUUID();
  const pageId = randomUUID();
  const issuer = 'https://id.example.test/oidc';
  const operationId = randomUUID();
  const actor = { id: actorId, workspaceId } as any;
  const dto = {
    pageId,
    subjectIssuer: issuer,
    subject: 'grant-recipient',
    operationId,
    expectedVersion: 2,
  };

  beforeAll(async () => {
    await db
      .insertInto('workspaces')
      .values({ id: workspaceId, name: 'Grant test', hostname: `grant-${workspaceId}` })
      .execute();
    await db
      .insertInto('users')
      .values([
        { id: actorId, workspaceId, name: 'Actor', email: `${actorId}@example.test` },
        { id: recipientId, workspaceId, name: 'Recipient', email: `${recipientId}@example.test` },
      ])
      .execute();
    await db
      .insertInto('spaces')
      .values({
        id: spaceId,
        workspaceId,
        creatorId: actorId,
        slug: `grant-${spaceId}`,
        name: 'Grant space',
      })
      .execute();
    await db
      .insertInto('pages')
      .values({
        id: pageId,
        workspaceId,
        spaceId,
        slugId: `grant-${pageId}`,
        title: 'Grant page',
        creatorId: actorId,
        lastUpdatedById: actorId,
      })
      .execute();
    await db
      .insertInto('lecIdentities')
      .values([
        { workspaceId, userId: actorId, issuer, subject: 'grant-actor' },
        { workspaceId, userId: recipientId, issuer, subject: dto.subject },
      ])
      .execute();
  });

  afterAll(async () => {
    await db.deleteFrom('spaceMembers').where('spaceId', '=', spaceId).execute();
    await db.deleteFrom('workspaces').where('id', '=', workspaceId).execute();
    await db.destroy();
  });

  it('Core 成功后崩溃可重放，并且通知与 IM intent 只创建一次', async () => {
    const policy = {
      send: jest.fn().mockResolvedValue({ data: { resource_version: 3 } }),
    };
    const repo = new NotificationRepo(db, {} as any);
    const notificationService = new NotificationService(
      repo,
      {} as any,
      { server: { to: () => ({ emit: jest.fn() }) } } as any,
      {} as any,
      db,
      {} as any,
      new UserRepo(db),
      { validateCanView: jest.fn() } as any,
    );
    const control = new LecPageControlService(
      { findAuthorizationSubject: jest.fn().mockResolvedValue({ id: pageId, workspaceId, spaceId, deletedAt: null }) } as any,
      { principal: jest.fn().mockResolvedValue({ type: 'OIDC', issuer, subject: 'grant-actor' }), deny: jest.fn(() => { throw new Error('denied'); }) } as any,
      policy as any,
      notificationService,
      db,
    );

    await db
      .insertInto('lecPageControlOperations')
      .values({
        id: operationId,
        workspaceId,
        pageId,
        spaceId,
        action: 'GRANT_VIEW',
        status: 'LOCAL_PENDING',
        actorUserId: actorId,
        actorIssuer: issuer,
        actorSubject: 'grant-actor',
        recipientUserId: recipientId,
        recipientIssuer: issuer,
        recipientSubject: dto.subject,
        expectedVersion: String(dto.expectedVersion),
      })
      .execute();

    await control.grantView(actor, dto);
    await control.grantView(actor, dto);

    expect(policy.send).not.toHaveBeenCalled();
    const native = await db
      .selectFrom('notifications')
      .select(['id', 'userId', 'type', 'actorId', 'pageId'])
      .where('id', '=', operationId)
      .execute();
    expect(native).toEqual([
      {
        id: operationId,
        userId: recipientId,
        type: 'page.permission_granted',
        actorId,
        pageId,
      },
    ]);
    expect(
      await db.selectFrom('lecDocumentNotificationOutbox').select('notificationId').where('notificationId', '=', operationId).execute(),
    ).toHaveLength(1);
    expect(
      await db
        .selectFrom('spaceMembers')
        .select('id')
        .where('spaceId', '=', spaceId)
        .where('userId', '=', recipientId)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await db
        .selectFrom('lecPageGrantProjections')
        .select(['grantId', 'pageId', 'userId'])
        .where('grantId', '=', operationId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ grantId: operationId, pageId, userId: recipientId });
    const operation = await db
      .selectFrom('lecPageControlOperations')
      .select('status')
      .where('id', '=', operationId)
      .executeTakeFirstOrThrow();
    expect(operation.status).toBe('DONE');
  });
});
