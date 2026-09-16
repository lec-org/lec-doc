import { ConfigService } from '@nestjs/config';
import { CamelCasePlugin, Dialect, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres = require('postgres');
import { randomUUID } from 'node:crypto';
import { KyselyDB } from '../../database/types/kysely.types';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { OutboundUrlGuard } from '../../integrations/outbound/outbound-url.guard';
import { OutboundAgentFactory } from '../../integrations/outbound/outbound-agent.factory';
import { LecPolicyClient } from './lec-policy.client';
import { LecResourceLifecycleService } from './lec-resource-lifecycle.service';

const required = [
  'LEC_DOC_TEST_DATABASE_URL',
  'LEC_CORE_E2E_DATABASE_URL',
  'LEC_CORE_URL',
  'LEC_DOC_INTERNAL_TOKEN',
  'LEC_DOC_ORGANIZATION_ID',
  'LEC_DOC_E2E_WORKSPACE_ID',
  'LEC_DOC_E2E_USER_ID',
  'LEC_DOC_E2E_ISSUER',
  'LEC_DOC_E2E_SUBJECT',
];
const enabled = required.every((name) => process.env[name]);

(enabled ? describe : describe.skip)('真实 Core/Doc 页面生命周期 saga', () => {
  const workspaceId = process.env.LEC_DOC_E2E_WORKSPACE_ID!;
  const userId = process.env.LEC_DOC_E2E_USER_ID!;
  const principal = {
    type: 'OIDC' as const,
    issuer: process.env.LEC_DOC_E2E_ISSUER!,
    subject: process.env.LEC_DOC_E2E_SUBJECT!,
  };
  const spaceId = randomUUID();
  const rootId = randomUUID();
  const childId = randomUUID();
  let db: KyselyDB;
  let core: ReturnType<typeof postgres>;
  let policy: LecPolicyClient;
  let lifecycle: LecResourceLifecycleService;
  let emitAsync: jest.Mock;

  beforeAll(async () => {
    const config = new ConfigService(process.env);
    db = new Kysely({
      dialect: new PostgresJSDialect({
        postgres: postgres(process.env.LEC_DOC_TEST_DATABASE_URL!, { max: 4 }),
      }) as unknown as Dialect,
      plugins: [new CamelCasePlugin()],
    });
    core = postgres(process.env.LEC_CORE_E2E_DATABASE_URL!, { max: 2 });
    const environment = new EnvironmentService(config);
    policy = new LecPolicyClient(
      config,
      new OutboundAgentFactory(new OutboundUrlGuard(environment)),
    );
    emitAsync = jest.fn().mockResolvedValue([]);
    lifecycle = new LecResourceLifecycleService(db, policy, config, {
      emitAsync,
    } as never);
    await db
      .insertInto('workspaces')
      .values({ id: workspaceId, name: 'Phase 2 lifecycle E2E' })
      .execute();
    await db
      .insertInto('users')
      .values({
        id: userId,
        workspaceId,
        email: 'phase2-doc-owner@example.test',
        name: 'Phase 2 Doc Owner',
        role: 'owner',
      })
      .execute();
    await db
      .insertInto('lecIdentities')
      .values({
        workspaceId,
        userId,
        issuer: principal.issuer,
        subject: principal.subject,
      })
      .execute();
    await db
      .insertInto('spaces')
      .values({
        id: spaceId,
        workspaceId,
        creatorId: userId,
        name: 'Phase 2 Space',
        slug: `phase2-${spaceId.slice(0, 8)}`,
      })
      .execute();
  });

  afterAll(async () => {
    if (db) {
      await db.deleteFrom('workspaces').where('id', '=', workspaceId).execute();
      await db.destroy();
    }
    if (core) {
      await core`DELETE FROM doc_tree_operations WHERE workspace_id=${workspaceId}`;
      await core`DELETE FROM doc_access_requests WHERE workspace_id=${workspaceId}`;
      await core`DELETE FROM doc_grants WHERE workspace_id=${workspaceId}`;
      await core`DELETE FROM doc_resources WHERE workspace_id=${workspaceId}`;
      await core`DELETE FROM doc_workspaces WHERE workspace_id=${workspaceId}`;
      await core.end();
    }
  });

  it('Doc 插入前崩溃留下的 reservation 由 durable reconciliation 取消', async () => {
    const pageId = randomUUID();
    const user = { id: userId, workspaceId } as never;
    await lifecycle.ensureSpaceBound(user, principal, spaceId);
    const reservation = await lifecycle.reservePage(
      user,
      principal,
      pageId,
      'DOCMOST_SPACE',
      spaceId,
    );
    await db
      .updateTable('lecResourceOperations')
      .set({ availableAt: new Date(0) })
      .where('id', '=', reservation.operationId)
      .execute();
    await lifecycle.reconcile();
    const rows = await core`
      SELECT state FROM doc_resources
      WHERE workspace_id=${workspaceId} AND resource_id=${pageId}
    `;
    expect(rows).toEqual([{ state: 'CANCELLED' }]);
    expect(
      await db
        .selectFrom('lecResourceOperations')
        .select('status')
        .where('id', '=', reservation.operationId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'DONE' });
  });

  it('激活暂时失败时页面保持不可读，并由 durable reconciliation 恢复且投递事件', async () => {
    emitAsync.mockClear();
    const pageId = randomUUID();
    const user = { id: userId, workspaceId } as never;
    await lifecycle.ensureSpaceBound(user, principal, spaceId);
    const realPolicy = policy;
    const failingPolicy = {
      send: jest.fn((path, payload, schema) =>
        path === 'doc-resources/activate'
          ? Promise.reject(new Error('injected outage'))
          : realPolicy.send(path, payload, schema),
      ),
    } as unknown as LecPolicyClient;
    const failingLifecycle = new LecResourceLifecycleService(
      db,
      failingPolicy,
      new ConfigService(process.env),
      { emitAsync: jest.fn().mockResolvedValue([]) } as never,
    );
    await expect(
      failingLifecycle.createPage(
        user,
        principal,
        pageId,
        'DOCMOST_SPACE',
        spaceId,
        (trx) =>
          trx
            .insertInto('pages')
            .values({
              id: pageId,
              slugId: `retry-${pageId}`,
              title: 'Retry Page',
              workspaceId,
              spaceId,
              creatorId: userId,
              lastUpdatedById: userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
      ),
    ).rejects.toThrow('injected outage');
    const denied = await policy.authorize(workspaceId, principal, [
      {
        resource_kind: 'DOCMOST_PAGE',
        resource_id: pageId,
        capability: 'VIEW',
      },
    ]);
    expect(denied[0].allowed).toBe(false);
    const pending = await db
      .selectFrom('lecResourceOperations')
      .select('id')
      .where('workspaceId', '=', workspaceId)
      .where('resourceId', '=', pageId)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('lecResourceOperations')
      .set({ availableAt: new Date(0) })
      .where('id', '=', pending.id)
      .execute();
    await lifecycle.reconcile();
    const allowed = await policy.authorize(workspaceId, principal, [
      {
        resource_kind: 'DOCMOST_PAGE',
        resource_id: pageId,
        capability: 'VIEW',
      },
    ]);
    expect(allowed[0].allowed).toBe(true);
    expect(emitAsync).toHaveBeenCalledWith('page.created', {
      pageIds: [pageId],
      workspaceId,
      operationId: pending.id,
    });
    await db.deleteFrom('pages').where('id', '=', pageId).execute();
  }, 60_000);

  it('创建默认 L5 子树，删除后 fail closed，恢复后重新允许读取', async () => {
    const user = { id: userId, workspaceId } as never;
    const insert = (id: string, parentPageId: string | null) =>
      lifecycle.createPage(
        user,
        principal,
        id,
        parentPageId ? 'DOCMOST_PAGE' : 'DOCMOST_SPACE',
        parentPageId ?? spaceId,
        (trx) =>
          trx
            .insertInto('pages')
            .values({
              id,
              slugId: `e2e-${id}`,
              title: parentPageId ? 'Child' : 'Root',
              workspaceId,
              spaceId,
              parentPageId,
              creatorId: userId,
              lastUpdatedById: userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
      );

    await insert(rootId, null);
    await insert(childId, rootId);

    const coreRows = await core`
      SELECT resource_id, classification, state
      FROM doc_resources
      WHERE workspace_id=${workspaceId}
        AND resource_id IN (${rootId}, ${childId}, ${spaceId})
      ORDER BY resource_kind, resource_id
    `;
    expect(coreRows).toHaveLength(3);
    expect(
      coreRows
        .filter((row) => row.resource_id !== spaceId)
        .map((row) => [row.classification, row.state]),
    ).toEqual([
      [5, 'ACTIVE'],
      [5, 'ACTIVE'],
    ]);

    const pageItems = [rootId, childId].map((resource_id) => ({
      resource_kind: 'DOCMOST_PAGE' as const,
      resource_id,
      capability: 'DELETE' as const,
    }));
    const deletions = await policy.authorize(workspaceId, principal, pageItems);
    expect(deletions.every((decision) => decision.allowed)).toBe(true);
    await lifecycle.deleteTree(
      user,
      principal,
      rootId,
      deletions.map((decision) => ({
        id: decision.resource_id,
        resourceVersion: decision.resource_version,
      })),
    );
    expect(
      await db
        .selectFrom('pages')
        .select('id')
        .where('id', 'in', [rootId, childId])
        .where('deletedAt', 'is not', null)
        .execute(),
    ).toHaveLength(2);
    const denied = await policy.authorize(
      workspaceId,
      principal,
      pageItems.map((item) => ({ ...item, capability: 'VIEW' as const })),
    );
    expect(denied.every((decision) => !decision.allowed)).toBe(true);

    const restores = await policy.authorize(
      workspaceId,
      principal,
      pageItems.map((item) => ({ ...item, capability: 'RESTORE' as const })),
    );
    expect(
      restores.find((decision) => decision.resource_id === rootId)?.allowed,
    ).toBe(true);
    expect(
      restores.find((decision) => decision.resource_id === childId)?.allowed,
    ).toBe(false);
    const deletion = await lifecycle.findDeleteOperation(workspaceId, rootId);
    await lifecycle.restoreTree(
      user,
      principal,
      rootId,
      deletion.id,
      restores.map((decision) => ({
        id: decision.resource_id,
        resourceVersion: decision.resource_version,
      })),
    );
    expect(
      await db
        .selectFrom('pages')
        .select('id')
        .where('id', 'in', [rootId, childId])
        .where('deletedAt', 'is', null)
        .execute(),
    ).toHaveLength(2);
    const allowed = await policy.authorize(
      workspaceId,
      principal,
      pageItems.map((item) => ({ ...item, capability: 'VIEW' as const })),
    );
    expect(allowed.every((decision) => decision.allowed)).toBe(true);
  }, 60_000);
});
