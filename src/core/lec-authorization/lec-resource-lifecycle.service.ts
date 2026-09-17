import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { Selectable, sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { User } from '@docmost/db/types/entity.types';
import { LecResourceOperations } from '@docmost/db/types/lec-db';
import { EventName } from '../../common/events/event.contants';
import { LecPolicyClient } from './lec-policy.client';
import {
  LecPrincipal,
  LecResource,
  reparentEnvelopeSchema,
  resourceEnvelopeSchema,
  resourceKindSchema,
  treeResponseSchema,
} from './lec-policy.types';
import { z } from 'zod';

const createPayloadSchema = z.strictObject({
  parentKind: resourceKindSchema,
  parentId: z.uuid(),
  resourceVersion: z.number().int().min(1).optional(),
});
const treeItemSchema = z.strictObject({
  resourceKind: resourceKindSchema,
  resourceId: z.uuid(),
  resourceVersion: z.number().int().min(1),
});
const treePayloadSchema = z.strictObject({
  items: z.array(treeItemSchema).min(1).max(1000),
  deletedById: z.uuid().optional(),
  sourceOperationId: z.uuid().optional(),
  reactivateOperationId: z.uuid().optional(),
  cancelRestoreOperationId: z.uuid().optional(),
});
type LifecycleOperation = Selectable<LecResourceOperations>;
type OidcPrincipal = Extract<LecPrincipal, { type: 'OIDC' }>;

@Injectable()
export class LecResourceLifecycleService {
  private readonly logger = new Logger(LecResourceLifecycleService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly policy: LecPolicyClient,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  /** 组织 ID 只来自部署控制面配置，永不接受浏览器输入。 */
  async ensureSpaceBound(
    user: Pick<User, 'id' | 'workspaceId'>,
    principal: OidcPrincipal,
    spaceId: string,
  ) {
    const workspaceId = z.uuid().parse(user.workspaceId);
    z.uuid().parse(spaceId);
    let operation = await this.db
      .selectFrom('lecResourceOperations')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('resourceId', '=', spaceId)
      .where('action', '=', 'BIND_SPACE')
      .executeTakeFirst();
    if (!operation) {
      const organizationId = this.config.get<string>('LEC_DOC_ORGANIZATION_ID');
      if (!z.uuid().safeParse(organizationId).success) throw this.unavailable();
      const now = new Date();
      await this.db
        .insertInto('lecResourceOperations')
        .values({
          id: randomUUID(),
          workspaceId,
          resourceKind: 'DOCMOST_SPACE',
          resourceId: spaceId,
          action: 'BIND_SPACE',
          status: 'BIND_PENDING',
          registrationKey: randomUUID(),
          actorUserId: user.id,
          actorIssuer: principal.issuer,
          actorSubject: principal.subject,
          payload: { organizationId },
          availableAt: now,
          updatedAt: now,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      operation = await this.db
        .selectFrom('lecResourceOperations')
        .selectAll()
        .where('workspaceId', '=', workspaceId)
        .where('resourceId', '=', spaceId)
        .where('action', '=', 'BIND_SPACE')
        .executeTakeFirst();
    }
    if (!operation) throw this.unavailable();
    if (operation.status !== 'DONE') await this.processBind(operation);
  }

  /** Intent 必须先于 Core reserve 落库，才能回收调用期间崩溃留下的 reservation。 */
  async reservePage(
    user: Pick<User, 'id' | 'workspaceId'>,
    principal: OidcPrincipal,
    pageId: string,
    parentKind: z.infer<typeof resourceKindSchema>,
    parentId: string,
  ) {
    const workspaceId = z.uuid().parse(user.workspaceId);
    z.uuid().parse(user.id);
    z.uuid().parse(pageId);
    resourceKindSchema.parse(parentKind);
    z.uuid().parse(parentId);
    const operationId = randomUUID();
    const registrationKey = randomUUID();
    const now = new Date();
    await this.db
      .insertInto('lecResourceOperations')
      .values({
        id: operationId,
        workspaceId,
        resourceKind: 'DOCMOST_PAGE',
        resourceId: pageId,
        action: 'CREATE_PAGE',
        status: 'RESERVE_PENDING',
        registrationKey,
        actorUserId: user.id,
        actorIssuer: principal.issuer,
        actorSubject: principal.subject,
        payload: { parentKind, parentId },
        availableAt: now,
        updatedAt: now,
      })
      .execute();
    const operation = await this.operation(operationId);
    await this.processReserve(operation);
    return { operationId, registrationKey, resourceVersion: 1 as const };
  }

  async createPage<T>(
    user: Pick<User, 'id' | 'workspaceId'>,
    principal: OidcPrincipal,
    pageId: string,
    parentKind: z.infer<typeof resourceKindSchema>,
    parentId: string,
    insert: (trx: KyselyTransaction) => Promise<T>,
  ): Promise<T> {
    if (parentKind === 'DOCMOST_SPACE')
      await this.ensureSpaceBound(user, principal, parentId);
    const previous = await this.db
      .selectFrom('lecResourceOperations')
      .selectAll()
      .where('workspaceId', '=', user.workspaceId)
      .where('resourceId', '=', pageId)
      .where('action', '=', 'CREATE_PAGE')
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();
    const existing = previous
      ? await this.db
          .selectFrom('pages')
          .select('id')
          .where('id', '=', pageId)
          .where('workspaceId', '=', user.workspaceId)
          .executeTakeFirst()
      : undefined;
    if (previous && existing) {
      await this.processCreate(previous);
      return existing as T;
    }
    if (previous && previous.status !== 'DOC_INSERT_PENDING') {
      await this.processCreate(previous);
      throw new ConflictException('page lifecycle replay did not recover page');
    }
    const reservation = previous
      ? { operationId: previous.id }
      : await this.reservePage(user, principal, pageId, parentKind, parentId);
    let value: T;
    try {
      value = await this.db.transaction().execute(async (trx) => {
        const inserted = await insert(trx);
        await trx
          .updateTable('lecResourceOperations')
          .set({
            status: 'ACTIVATE_PENDING',
            availableAt: new Date(),
            updatedAt: new Date(),
          })
          .where('id', '=', reservation.operationId)
          .where('status', '=', 'DOC_INSERT_PENDING')
          .executeTakeFirstOrThrow();
        return inserted;
      });
    } catch (error) {
      await this.db
        .updateTable('lecResourceOperations')
        .set({
          status: 'CANCEL_PENDING',
          availableAt: new Date(),
          updatedAt: new Date(),
        })
        .where('id', '=', reservation.operationId)
        .execute();
      try {
        await this.processCreate(await this.operation(reservation.operationId));
      } catch {
        // Compensation remains durable and is retried by reconciliation.
      }
      throw error;
    }
    await this.processCreate(await this.operation(reservation.operationId));
    return value;
  }

  async movePage<T>(
    user: Pick<User, 'id' | 'workspaceId'>,
    principal: OidcPrincipal,
    pageId: string,
    expectedVersion: number,
    parentKind: 'DOCMOST_SPACE' | 'DOCMOST_PAGE',
    parentId: string,
    move: (trx: KyselyTransaction) => Promise<T>,
  ): Promise<T> {
    const operationId = randomUUID();
    const payload = { parentKind, parentId, expectedVersion };
    const now = new Date();
    await this.db
      .insertInto('lecResourceOperations')
      .values({
        id: operationId,
        workspaceId: user.workspaceId,
        resourceKind: 'DOCMOST_PAGE',
        resourceId: pageId,
        action: 'REPARENT_PAGE',
        status: 'CORE_REPARENT_PREPARE_PENDING',
        actorUserId: user.id,
        actorIssuer: principal.issuer,
        actorSubject: principal.subject,
        payload,
        availableAt: now,
        updatedAt: now,
      })
      .execute();
    let operation = await this.operation(operationId);
    await this.processReparent(operation);
    operation = await this.operation(operationId);
    if (operation.status !== 'DOC_REPARENT_PENDING') throw this.unavailable();

    let value: T;
    try {
      value = await this.db.transaction().execute(async (trx) => {
        const moved = await move(trx);
        await trx
          .updateTable('lecResourceOperations')
          .set({
            status: 'CORE_REPARENT_COMMIT_PENDING',
            availableAt: new Date(),
            updatedAt: new Date(),
          })
          .where('id', '=', operationId)
          .where('status', '=', 'DOC_REPARENT_PENDING')
          .executeTakeFirstOrThrow();
        return moved;
      });
    } catch (error) {
      await this.db
        .updateTable('lecResourceOperations')
        .set({
          status: 'CORE_REPARENT_CANCEL_PENDING',
          availableAt: new Date(),
          updatedAt: new Date(),
        })
        .where('id', '=', operationId)
        .where('status', '=', 'DOC_REPARENT_PENDING')
        .execute();
      try {
        await this.processReparent(await this.operation(operationId));
      } catch {
        // Durable cancellation remains pending for reconciliation.
      }
      throw error;
    }

    try {
      await this.processReparent(await this.operation(operationId));
    } catch (error) {
      await this.recordFailure(await this.operation(operationId), error);
      if (error instanceof HttpException && error.getStatus() < 500) {
        throw error;
      }
    }
    return value;
  }

  async deleteTree(
    user: Pick<User, 'id' | 'workspaceId'>,
    principal: OidcPrincipal,
    rootId: string,
    items: { id: string; resourceVersion: number }[],
  ) {
    const operation = await this.startTree(
      'DELETE_TREE',
      'CORE_DELETE_PENDING',
      user,
      principal,
      rootId,
      {
        items: items.map((item) => ({
          resourceKind: 'DOCMOST_PAGE' as const,
          resourceId: item.id,
          resourceVersion: item.resourceVersion,
        })),
        deletedById: user.id,
      },
    );
    const staged = await this.treeCommand('delete', operation);
    await this.db.transaction().execute(async (trx) => {
      const pageIds = staged.items.map((item) => item.resource_id);
      await trx
        .updateTable('pages')
        .set({ deletedById: user.id, deletedAt: new Date() })
        .where('id', 'in', pageIds)
        .where('deletedAt', 'is', null)
        .execute();
      await trx.deleteFrom('shares').where('pageId', 'in', pageIds).execute();
      await trx
        .updateTable('lecResourceOperations')
        .set({
          status: 'DELETE_EVENT_PENDING',
          payload: { items: this.versions(staged.items) },
          availableAt: new Date(),
          updatedAt: new Date(),
        })
        .where('id', '=', operation.id)
        .executeTakeFirstOrThrow();
    });
    await this.emitSoon(await this.operation(operation.id));
  }

  async requireDeletedTree(
    workspaceId: string,
    rootId: string,
    items?: { id: string; resourceVersion?: number }[],
  ) {
    const deletion = await this.findDeleteOperation(workspaceId, rootId);
    const payload = treePayloadSchema.parse(deletion.payload);
    const deleted = new Map(
      payload.items.map((item) => [item.resourceId, item.resourceVersion]),
    );
    if (
      items &&
      (items.length !== deleted.size ||
        items.some(
          (item) =>
            !deleted.has(item.id) ||
            (item.resourceVersion !== undefined &&
              deleted.get(item.id) !== item.resourceVersion),
        ))
    )
      throw this.versionConflict();

    const current = new Map<string, number>();
    for (let index = 0; index < payload.items.length; index += 100) {
      const decisions = await this.policy.authorize(
        workspaceId,
        this.principal(deletion),
        payload.items.slice(index, index + 100).map((item) => ({
          resource_kind: item.resourceKind,
          resource_id: item.resourceId,
          capability: 'RESTORE',
        })),
      );
      decisions.forEach((decision) => {
        if (decision.allowed)
          current.set(decision.resource_id, decision.resource_version);
      });
    }
    if (
      current.size !== deleted.size ||
      [...deleted].some(([id, version]) => current.get(id) !== version)
    )
      throw this.versionConflict();
  }

  async findDeleteOperation(workspaceId: string, rootId: string) {
    const operation = await this.db
      .selectFrom('lecResourceOperations')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('resourceKind', '=', 'DOCMOST_PAGE')
      .where('resourceId', '=', rootId)
      .where('action', '=', 'DELETE_TREE')
      .where('status', '=', 'DONE')
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();
    if (!operation)
      throw new ConflictException({
        code: 'DOC_VERSION_CONFLICT',
        message: '缺少可恢复的文档删除记录',
      });
    return operation;
  }

  async restoreTree(
    user: Pick<User, 'id' | 'workspaceId'>,
    principal: OidcPrincipal,
    rootId: string,
    deleteOperationId: string,
    items: { id: string; resourceVersion: number }[],
  ) {
    const operation = await this.startTree(
      'RESTORE_TREE',
      'CORE_RESTORE_PENDING',
      user,
      principal,
      rootId,
      {
        items: items.map((item) => ({
          resourceKind: 'DOCMOST_PAGE' as const,
          resourceId: item.id,
          resourceVersion: item.resourceVersion,
        })),
        sourceOperationId: deleteOperationId,
      },
      deleteOperationId,
    );
    const staged = await this.treeCommand('restore', operation);
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('pages')
          .set({ deletedById: null, deletedAt: null })
          .where(
            'id',
            'in',
            staged.items.map((item) => item.resource_id),
          )
          .execute();
        await trx
          .updateTable('lecResourceOperations')
          .set({
            status: 'CORE_REACTIVATE_PENDING',
            payload: {
              items: this.versions(staged.items),
              sourceOperationId: operation.id,
              reactivateOperationId: randomUUID(),
            },
            updatedAt: new Date(),
          })
          .where('id', '=', operation.id)
          .executeTakeFirstOrThrow();
      });
    } catch (error) {
      await this.db
        .updateTable('lecResourceOperations')
        .set({
          status: 'CORE_CANCEL_RESTORE_PENDING',
          payload: {
            items: this.versions(staged.items),
            sourceOperationId: operation.id,
            cancelRestoreOperationId: randomUUID(),
          },
          availableAt: new Date(),
          updatedAt: new Date(),
        })
        .where('id', '=', operation.id)
        .execute();
      try {
        await this.processTree(await this.operation(operation.id));
      } catch {
        // Durable compensation remains pending.
      }
      throw error;
    }
    await this.processTree(await this.operation(operation.id));
  }

  @Interval('lec-resource-reconciliation', 5_000)
  async reconcile() {
    try {
      const due = await this.db
        .selectFrom('lecResourceOperations')
        .select('id')
        .where('status', 'in', [
          'BIND_PENDING',
          'RESERVE_PENDING',
          'DOC_INSERT_PENDING',
          'ACTIVATE_PENDING',
          'CANCEL_PENDING',
          'CORE_DELETE_PENDING',
          'DOC_DELETE_PENDING',
          'CORE_RESTORE_PENDING',
          'DOC_RESTORE_PENDING',
          'CORE_REACTIVATE_PENDING',
          'CORE_CANCEL_RESTORE_PENDING',
          'CREATE_EVENT_PENDING',
          'DELETE_EVENT_PENDING',
          'RESTORE_EVENT_PENDING',
          'CORE_REPARENT_PREPARE_PENDING',
          'DOC_REPARENT_PENDING',
          'CORE_REPARENT_COMMIT_PENDING',
          'CORE_REPARENT_CANCEL_PENDING',
        ])
        .where('availableAt', '<=', new Date())
        .where((eb) =>
          eb.or([
            eb('leaseUntil', 'is', null),
            eb('leaseUntil', '<', new Date()),
          ]),
        )
        .orderBy('createdAt', 'asc')
        .limit(20)
        .execute();
      for (const candidate of due) await this.reconcileOne(candidate.id);
    } catch (error) {
      this.logger.error(
        `Lec resource reconciliation failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private async reconcileOne(id: string) {
    const leaseUntil = new Date(Date.now() + 30_000);
    const claimed = await this.db
      .updateTable('lecResourceOperations')
      .set({ leaseUntil, updatedAt: new Date() })
      .where('id', '=', id)
      .where((eb) =>
        eb.or([
          eb('leaseUntil', 'is', null),
          eb('leaseUntil', '<', new Date()),
        ]),
      )
      .returningAll()
      .executeTakeFirst();
    if (!claimed) return;
    try {
      if (claimed.action === 'BIND_SPACE') await this.processBind(claimed);
      if (claimed.action === 'CREATE_PAGE') await this.processCreate(claimed);
      if (claimed.action === 'REPARENT_PAGE')
        await this.processReparent(claimed);
      if (claimed.action === 'DELETE_TREE' || claimed.action === 'RESTORE_TREE')
        await this.processTree(claimed);
    } catch (error) {
      await this.recordFailure(claimed, error);
    }
  }

  private async processReparent(operation: LifecycleOperation) {
    if (operation.status === 'DONE') return;
    if (operation.status === 'DOC_REPARENT_PENDING') {
      await this.pending(operation.id, 'CORE_REPARENT_CANCEL_PENDING');
      operation = await this.operation(operation.id);
    }
    const payload = z
      .strictObject({
        parentKind: resourceKindSchema,
        parentId: z.uuid(),
        expectedVersion: z.number().int().min(1),
      })
      .parse(operation.payload);
    const action =
      operation.status === 'CORE_REPARENT_PREPARE_PENDING'
        ? 'PREPARE'
        : operation.status === 'CORE_REPARENT_COMMIT_PENDING'
          ? 'COMMIT'
          : operation.status === 'CORE_REPARENT_CANCEL_PENDING'
            ? 'CANCEL'
            : undefined;
    if (!action) return;
    const response = await this.policy.send(
      'doc-control/reparent',
      {
        request_id: randomUUID(),
        workspace_id: operation.workspaceId,
        principal: this.principal(operation),
        resource_kind: 'DOCMOST_PAGE',
        resource_id: operation.resourceId,
        expected_version: payload.expectedVersion,
        operation_id: operation.id,
        action,
        parent_kind: payload.parentKind,
        parent_id: payload.parentId,
      },
      reparentEnvelopeSchema,
    );
    if (
      response.data.workspace_id !== operation.workspaceId ||
      response.data.resource_kind !== 'DOCMOST_PAGE' ||
      response.data.resource_id !== operation.resourceId ||
      response.data.operation_id !== operation.id
    )
      throw this.unavailable();
    if (action === 'PREPARE') {
      if (response.data.operation_status !== 'PREPARED')
        throw this.unavailable();
      await this.pending(operation.id, 'DOC_REPARENT_PENDING');
      return;
    }
    if (
      response.data.operation_status !==
      (action === 'COMMIT' ? 'COMMITTED' : 'CANCELLED')
    )
      throw this.unavailable();
    await this.done(operation.id);
  }

  private async processBind(operation: LifecycleOperation) {
    const payload = z
      .strictObject({ organizationId: z.uuid() })
      .parse(operation.payload);
    const principal = this.principal(operation);
    const resource = this.matchResource(
      (
        await this.policy.send(
          'doc-spaces/bind',
          {
            request_id: randomUUID(),
            workspace_id: operation.workspaceId,
            principal,
            organization_id: payload.organizationId,
            space_id: operation.resourceId,
            registration_key: operation.registrationKey,
          },
          resourceEnvelopeSchema,
        )
      ).data,
      operation,
    );
    if (resource.state === 'RESERVED') {
      await this.transition(operation, principal, 'activate', resource);
    } else if (resource.state !== 'ACTIVE') {
      throw this.unavailable();
    }
    await this.done(operation.id);
  }

  private async processReserve(operation: LifecycleOperation) {
    const payload = createPayloadSchema.parse(operation.payload);
    const resource = this.matchResource(
      (
        await this.policy.send(
          'doc-resources/reserve',
          {
            request_id: randomUUID(),
            workspace_id: operation.workspaceId,
            principal: this.principal(operation),
            resource_id: operation.resourceId,
            parent_kind: payload.parentKind,
            parent_id: payload.parentId,
            registration_key: operation.registrationKey,
          },
          resourceEnvelopeSchema,
        )
      ).data,
      operation,
    );
    if (
      resource.parent_kind !== payload.parentKind ||
      resource.parent_id !== payload.parentId ||
      resource.classification !== 5 ||
      (resource.state !== 'RESERVED' && resource.state !== 'ACTIVE')
    )
      throw this.unavailable();
    await this.db
      .updateTable('lecResourceOperations')
      .set({
        status: resource.state === 'ACTIVE' ? 'DONE' : 'DOC_INSERT_PENDING',
        payload: {
          ...payload,
          resourceVersion: resource.resource_version,
        },
        availableAt: new Date(Date.now() + 30_000),
        leaseUntil: null,
        updatedAt: new Date(),
      })
      .where('id', '=', operation.id)
      .execute();
  }

  private async processCreate(operation: LifecycleOperation) {
    if (operation.status === 'CREATE_EVENT_PENDING') {
      await this.emitSoon(operation);
      return;
    }
    if (operation.status === 'DONE') {
      const page = await this.db
        .selectFrom('pages')
        .select('id')
        .where('id', '=', operation.resourceId)
        .executeTakeFirst();
      if (!page) throw new ConflictException('activated resource has no page');
      return;
    }
    if (operation.status === 'RESERVE_PENDING') {
      await this.processReserve(operation);
      return;
    }
    const payload = createPayloadSchema.parse(operation.payload);
    if (!payload.resourceVersion) throw this.unavailable();
    if (operation.status === 'DOC_INSERT_PENDING') {
      const page = await this.db
        .selectFrom('pages')
        .select('id')
        .where('id', '=', operation.resourceId)
        .executeTakeFirst();
      if (page) {
        await this.db
          .updateTable('lecResourceOperations')
          .set({
            status: 'ACTIVATE_PENDING',
            availableAt: new Date(),
            leaseUntil: null,
            updatedAt: new Date(),
          })
          .where('id', '=', operation.id)
          .execute();
        operation = await this.operation(operation.id);
      } else if (operation.availableAt <= new Date()) {
        await this.db
          .updateTable('lecResourceOperations')
          .set({
            status: 'CANCEL_PENDING',
            availableAt: new Date(),
            leaseUntil: null,
            updatedAt: new Date(),
          })
          .where('id', '=', operation.id)
          .execute();
        operation = await this.operation(operation.id);
      } else {
        return;
      }
    }
    if (
      operation.status !== 'ACTIVATE_PENDING' &&
      operation.status !== 'CANCEL_PENDING'
    )
      return;
    const action =
      operation.status === 'ACTIVATE_PENDING' ? 'activate' : 'cancel';
    await this.transition(operation, this.principal(operation), action, {
      resource_version: payload.resourceVersion,
    } as LecResource);
    if (action === 'cancel') {
      await this.done(operation.id);
      return;
    }
    await this.pending(operation.id, 'CREATE_EVENT_PENDING');
    await this.emitSoon(await this.operation(operation.id));
  }

  private async startTree(
    action: 'DELETE_TREE' | 'RESTORE_TREE',
    status: string,
    user: Pick<User, 'id' | 'workspaceId'>,
    principal: OidcPrincipal,
    rootId: string,
    payload: z.infer<typeof treePayloadSchema>,
    sourceOperationId?: string,
  ) {
    z.uuid().parse(rootId);
    const parsed = treePayloadSchema.parse(payload);
    const now = new Date();
    const operation: LifecycleOperation = {
      id: randomUUID(),
      workspaceId: user.workspaceId,
      resourceKind: 'DOCMOST_PAGE',
      resourceId: rootId,
      action,
      status,
      registrationKey: null,
      sourceOperationId: sourceOperationId ?? null,
      actorUserId: user.id,
      actorIssuer: principal.issuer,
      actorSubject: principal.subject,
      payload: parsed,
      attempts: 0,
      availableAt: now,
      leaseUntil: null,
      lastErrorCode: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db
      .insertInto('lecResourceOperations')
      .values(operation)
      .execute();
    return operation;
  }

  private async treeCommand(
    action: 'delete' | 'restore' | 'reactivate' | 'cancel-restore',
    operation: LifecycleOperation,
  ) {
    const payload = treePayloadSchema.parse(operation.payload);
    const root = payload.items.find(
      (item) => item.resourceId === operation.resourceId,
    );
    if (!root) throw this.unavailable();
    const response = await this.policy.send(
      `doc-trees/${action}`,
      {
        request_id: randomUUID(),
        workspace_id: operation.workspaceId,
        principal: this.principal(operation),
        resource_kind: operation.resourceKind,
        resource_id: operation.resourceId,
        expected_version: root.resourceVersion,
        operation_id:
          action === 'delete' || action === 'restore'
            ? operation.id
            : action === 'reactivate'
              ? payload.reactivateOperationId
              : payload.cancelRestoreOperationId,
        ...(action === 'delete'
          ? {}
          : {
              source_operation_id:
                action === 'restore'
                  ? operation.sourceOperationId
                  : payload.sourceOperationId,
            }),
        items: payload.items.map((item) => ({
          resource_kind: item.resourceKind,
          resource_id: item.resourceId,
          resource_version: item.resourceVersion,
        })),
      },
      treeResponseSchema,
    );
    if (
      response.data.resource_id !== operation.resourceId ||
      response.data.resource_kind !== operation.resourceKind ||
      response.data.items.length !== payload.items.length
    )
      throw this.unavailable();
    const expectedIds = new Set(payload.items.map((item) => item.resourceId));
    if (
      response.data.items.some(
        (item) =>
          item.workspace_id !== operation.workspaceId ||
          item.resource_kind !== 'DOCMOST_PAGE' ||
          !expectedIds.delete(item.resource_id),
      ) ||
      expectedIds.size
    )
      throw this.unavailable();
    return response.data;
  }

  private async processTree(operation: LifecycleOperation) {
    if (operation.status === 'CORE_DELETE_PENDING') {
      const staged = await this.treeCommand('delete', operation);
      await this.db
        .updateTable('lecResourceOperations')
        .set({
          status: 'DOC_DELETE_PENDING',
          payload: {
            ...treePayloadSchema.parse(operation.payload),
            items: this.versions(staged.items),
          },
          leaseUntil: null,
          availableAt: new Date(),
          updatedAt: new Date(),
        })
        .where('id', '=', operation.id)
        .execute();
      return;
    }
    if (operation.status === 'DELETE_EVENT_PENDING') {
      await this.emitSoon(operation);
      return;
    }
    if (operation.status === 'DOC_DELETE_PENDING') {
      const payload = treePayloadSchema.parse(operation.payload);
      if (!payload.deletedById) throw this.unavailable();
      const pageIds = payload.items.map((item) => item.resourceId);
      await this.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('pages')
          .set({ deletedById: payload.deletedById, deletedAt: new Date() })
          .where('id', 'in', pageIds)
          .where('deletedAt', 'is', null)
          .execute();
        await trx.deleteFrom('shares').where('pageId', 'in', pageIds).execute();
        await trx
          .updateTable('lecResourceOperations')
          .set({
            status: 'DELETE_EVENT_PENDING',
            leaseUntil: null,
            availableAt: new Date(),
            lastErrorCode: null,
            updatedAt: new Date(),
          })
          .where('id', '=', operation.id)
          .executeTakeFirstOrThrow();
      });
      await this.emitSoon(await this.operation(operation.id));
      return;
    }
    if (operation.status === 'CORE_RESTORE_PENDING') {
      const staged = await this.treeCommand('restore', operation);
      await this.db
        .updateTable('lecResourceOperations')
        .set({
          status: 'DOC_RESTORE_PENDING',
          payload: {
            ...treePayloadSchema.parse(operation.payload),
            items: this.versions(staged.items),
            sourceOperationId: operation.id,
            reactivateOperationId: randomUUID(),
          },
          leaseUntil: null,
          availableAt: new Date(),
          updatedAt: new Date(),
        })
        .where('id', '=', operation.id)
        .execute();
      return;
    }
    if (operation.status === 'DOC_RESTORE_PENDING') {
      const payload = treePayloadSchema.parse(operation.payload);
      await this.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('pages')
          .set({ deletedById: null, deletedAt: null })
          .where(
            'id',
            'in',
            payload.items.map((item) => item.resourceId),
          )
          .execute();
        await trx
          .updateTable('lecResourceOperations')
          .set({
            status: 'CORE_REACTIVATE_PENDING',
            leaseUntil: null,
            availableAt: new Date(),
            updatedAt: new Date(),
          })
          .where('id', '=', operation.id)
          .executeTakeFirstOrThrow();
      });
      return;
    }
    if (
      operation.status === 'CORE_REACTIVATE_PENDING' ||
      operation.status === 'CORE_CANCEL_RESTORE_PENDING'
    ) {
      await this.treeCommand(
        operation.status === 'CORE_REACTIVATE_PENDING'
          ? 'reactivate'
          : 'cancel-restore',
        operation,
      );
      if (operation.status === 'CORE_CANCEL_RESTORE_PENDING') {
        await this.done(operation.id);
        return;
      }
      await this.pending(operation.id, 'RESTORE_EVENT_PENDING');
      await this.emitSoon(await this.operation(operation.id));
      return;
    }
    if (
      operation.status === 'CREATE_EVENT_PENDING' ||
      operation.status === 'DELETE_EVENT_PENDING' ||
      operation.status === 'RESTORE_EVENT_PENDING'
    )
      await this.emitSoon(operation);
  }

  private versions(resources: LecResource[]) {
    return resources.map((resource) => ({
      resourceKind: resource.resource_kind,
      resourceId: resource.resource_id,
      resourceVersion: resource.resource_version,
    }));
  }

  private async transition(
    operation: LifecycleOperation,
    principal: OidcPrincipal,
    action: 'activate' | 'cancel',
    resource: Pick<LecResource, 'resource_version'>,
  ) {
    const response = await this.policy.send(
      `doc-resources/${action}`,
      {
        request_id: randomUUID(),
        workspace_id: operation.workspaceId,
        principal,
        resource_kind: operation.resourceKind,
        resource_id: operation.resourceId,
        registration_key: operation.registrationKey,
        expected_version: resource.resource_version,
        operation_id: operation.id,
      },
      resourceEnvelopeSchema,
    );
    const transitioned = this.matchResource(response.data, operation);
    const expected = action === 'activate' ? 'ACTIVE' : 'CANCELLED';
    if (transitioned.state !== expected) throw this.unavailable();
  }

  private matchResource(resource: LecResource, operation: LifecycleOperation) {
    if (
      resource.workspace_id !== operation.workspaceId ||
      resource.resource_kind !== operation.resourceKind ||
      resource.resource_id !== operation.resourceId ||
      resource.registration_key !== operation.registrationKey
    )
      throw this.unavailable();
    return resource;
  }

  private principal(operation: LifecycleOperation): OidcPrincipal {
    return {
      type: 'OIDC',
      issuer: operation.actorIssuer,
      subject: operation.actorSubject,
    };
  }

  private operation(id: string) {
    return this.db
      .selectFrom('lecResourceOperations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  private async pending(id: string, status: string) {
    await this.db
      .updateTable('lecResourceOperations')
      .set({
        status,
        leaseUntil: null,
        availableAt: new Date(),
        lastErrorCode: null,
        updatedAt: new Date(),
      })
      .where('id', '=', id)
      .execute();
  }

  private async emitSoon(operation: LifecycleOperation) {
    try {
      await this.emitEvent(operation);
    } catch (error) {
      await this.recordFailure(operation, error);
    }
  }

  private async emitEvent(operation: LifecycleOperation) {
    const payload =
      operation.action === 'CREATE_PAGE'
        ? createPayloadSchema.parse(operation.payload)
        : treePayloadSchema.parse(operation.payload);
    const pageIds =
      'items' in payload
        ? payload.items.map((item) => item.resourceId)
        : [operation.resourceId];
    const event =
      operation.status === 'CREATE_EVENT_PENDING'
        ? EventName.PAGE_CREATED
        : operation.status === 'DELETE_EVENT_PENDING'
          ? EventName.PAGE_SOFT_DELETED
          : EventName.PAGE_RESTORED;
    await this.events.emitAsync(event, {
      pageIds,
      workspaceId: operation.workspaceId,
      operationId: operation.id,
    });
    await this.done(operation.id);
  }

  private async done(id: string) {
    await this.db
      .updateTable('lecResourceOperations')
      .set({
        status: 'DONE',
        leaseUntil: null,
        lastErrorCode: null,
        updatedAt: new Date(),
      })
      .where('id', '=', id)
      .execute();
  }

  private async recordFailure(operation: LifecycleOperation, error: unknown) {
    const terminal =
      error instanceof ConflictException ||
      error instanceof ForbiddenException ||
      (error instanceof HttpException && error.getStatus() === 400);
    const attempts = operation.attempts + 1;
    await this.db
      .updateTable('lecResourceOperations')
      .set({
        status: terminal ? 'FAILED' : operation.status,
        attempts,
        availableAt: new Date(
          Date.now() + Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8)),
        ),
        leaseUntil: null,
        lastErrorCode: terminal ? 'PERMANENT' : 'RETRYABLE',
        updatedAt: new Date(),
      })
      .where('id', '=', operation.id)
      .execute();
  }

  private versionConflict() {
    return new ConflictException({
      code: 'DOC_VERSION_CONFLICT',
      message: '文档删除状态已变化，请刷新重试',
    });
  }

  private unavailable() {
    return new ServiceUnavailableException({
      code: 'DOC_AUTHORIZATION_UNAVAILABLE',
      message: '文档授权暂不可用，请稍后重试',
    });
  }
}
