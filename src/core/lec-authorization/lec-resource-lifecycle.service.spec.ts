import { ConfigService } from '@nestjs/config';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LecResourceLifecycleService } from './lec-resource-lifecycle.service';
import { LecPolicyClient } from './lec-policy.client';

const principal = {
  type: 'OIDC' as const,
  issuer: 'https://sso.example.test/realms/lec',
  subject: 'owner-subject',
};

function operation(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    workspaceId: randomUUID(),
    resourceKind: 'DOCMOST_PAGE',
    resourceId: randomUUID(),
    action: 'CREATE_PAGE',
    status: 'RESERVE_PENDING',
    registrationKey: randomUUID(),
    sourceOperationId: null,
    actorUserId: randomUUID(),
    actorIssuer: principal.issuer,
    actorSubject: principal.subject,
    payload: { parentKind: 'DOCMOST_SPACE', parentId: randomUUID() },
    attempts: 0,
    availableAt: new Date(),
    leaseUntil: null,
    lastErrorCode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function database(rows: ReturnType<typeof operation>[] = []) {
  return {
    transaction: () => ({ execute: (fn: (trx: unknown) => unknown) => fn(db) }),
    insertInto: () => ({
      values: (value: ReturnType<typeof operation>) => ({
        onConflict: () => ({
          doNothing: () => ({ execute: async () => rows.push(value) }),
        }),
        execute: async () => rows.push(value),
      }),
    }),
    selectFrom: () => ({
      selectAll: () => {
        const query = {
          where: () => query,
          forUpdate: () => query,
          skipLocked: () => query,
          orderBy: () => query,
          executeTakeFirst: async () => rows[0],
          executeTakeFirstOrThrow: async () => {
            if (!rows[0]) throw new Error('not found');
            return rows[0];
          },
        };
        return query;
      },
    }),
    updateTable: () => ({
      set: (value: Record<string, unknown>) => ({
        where: () => ({
          where: () => ({
            execute: async () => Object.assign(rows[0], value),
          }),
          execute: async () => Object.assign(rows[0], value),
        }),
      }),
    }),
  };
}
let db: ReturnType<typeof database>;

describe('Lec resource lifecycle', () => {
  it('reserve 前先持久化 intent；成功后进入 activate pending', async () => {
    const rows: ReturnType<typeof operation>[] = [];
    db = database(rows);
    const policy = {
      send: jest.fn().mockImplementation((_path, payload) =>
        Promise.resolve({
          data: {
            workspace_id: payload.workspace_id,
            resource_kind: 'DOCMOST_PAGE',
            resource_id: payload.resource_id,
            organization_id: randomUUID(),
            parent_kind: payload.parent_kind,
            parent_id: payload.parent_id,
            owner_user_id: randomUUID(),
            classification: 5,
            state: 'RESERVED',
            resource_version: 1,
            registration_key: payload.registration_key,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        }),
      ),
    } as unknown as LecPolicyClient;
    const service = new LecResourceLifecycleService(
      db as never,
      policy,
      new ConfigService(),
      { emitAsync: jest.fn().mockResolvedValue([]) } as never,
    );
    const pageId = randomUUID();
    const workspaceId = randomUUID();
    const registration = await service.reservePage(
      { id: randomUUID(), workspaceId } as never,
      principal,
      pageId,
      'DOCMOST_SPACE',
      randomUUID(),
    );
    expect(rows[0]).toMatchObject({
      id: registration.operationId,
      workspaceId,
      resourceId: pageId,
      status: 'DOC_INSERT_PENDING',
    });
    expect(policy.send).toHaveBeenCalledTimes(1);
  });

  it('reserve 网络失败保留 RESERVE_PENDING 供 reconciler 重试', async () => {
    const rows: ReturnType<typeof operation>[] = [];
    const policy = {
      send: jest.fn().mockRejectedValue(new ServiceUnavailableException()),
    } as unknown as LecPolicyClient;
    const service = new LecResourceLifecycleService(
      database(rows) as never,
      policy,
      new ConfigService(),
      { emitAsync: jest.fn().mockResolvedValue([]) } as never,
    );
    await expect(
      service.reservePage(
        { id: randomUUID(), workspaceId: randomUUID() } as never,
        principal,
        randomUUID(),
        'DOCMOST_SPACE',
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(rows[0].status).toBe('RESERVE_PENDING');
  });

  describe('permanent-delete fence', () => {
    const workspaceId = randomUUID();
    const rootId = randomUUID();
    const childId = randomUUID();
    const items = [
      { resourceKind: 'DOCMOST_PAGE', resourceId: rootId, resourceVersion: 2 },
      { resourceKind: 'DOCMOST_PAGE', resourceId: childId, resourceVersion: 2 },
    ];
    const deletion = operation({
      workspaceId,
      resourceId: rootId,
      action: 'DELETE_TREE',
      status: 'DONE',
      payload: { items },
    });

    const decision = (
      item: (typeof items)[number],
      resourceVersion = item.resourceVersion,
    ) => ({
      workspace_id: workspaceId,
      resource_kind: item.resourceKind,
      resource_id: item.resourceId,
      capability: 'RESTORE',
      resource_version: resourceVersion,
      allowed: true,
    });

    it('checks current Core versions immediately before physical deletion', async () => {
      const policy = {
        authorize: jest
          .fn()
          .mockResolvedValue(items.map((item) => decision(item))),
      } as unknown as LecPolicyClient;
      const service = new LecResourceLifecycleService(
        database([deletion]) as never,
        policy,
        new ConfigService(),
        { emitAsync: jest.fn() } as never,
      );

      await expect(
        service.requireDeletedTree(workspaceId, rootId),
      ).resolves.toBeUndefined();
      expect(policy.authorize).toHaveBeenCalledWith(
        workspaceId,
        principal,
        items.map((item) => ({
          resource_kind: item.resourceKind,
          resource_id: item.resourceId,
          capability: 'RESTORE',
        })),
      );
    });

    it('rejects a Core version mismatch', async () => {
      const policy = {
        authorize: jest
          .fn()
          .mockResolvedValue(items.map((item) => decision(item, 3))),
      } as unknown as LecPolicyClient;
      const service = new LecResourceLifecycleService(
        database([deletion]) as never,
        policy,
        new ConfigService(),
        { emitAsync: jest.fn() } as never,
      );

      await expect(
        service.requireDeletedTree(workspaceId, rootId),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects ACTIVE Core resources', async () => {
      const policy = {
        authorize: jest
          .fn()
          .mockResolvedValue(
            items.map((item) => ({ ...decision(item), allowed: false })),
          ),
      } as unknown as LecPolicyClient;
      const service = new LecResourceLifecycleService(
        database([deletion]) as never,
        policy,
        new ConfigService(),
        { emitAsync: jest.fn() } as never,
      );

      await expect(
        service.requireDeletedTree(workspaceId, rootId),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('fails closed when Core is unavailable', async () => {
      const policy = {
        authorize: jest
          .fn()
          .mockRejectedValue(new ServiceUnavailableException()),
      } as unknown as LecPolicyClient;
      const service = new LecResourceLifecycleService(
        database([deletion]) as never,
        policy,
        new ConfigService(),
        { emitAsync: jest.fn() } as never,
      );

      await expect(
        service.requireDeletedTree(workspaceId, rootId),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
