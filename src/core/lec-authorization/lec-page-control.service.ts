import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { User } from '@docmost/db/types/entity.types';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { z } from 'zod';
import { NotificationType } from '../notification/notification.constants';
import { NotificationService } from '../notification/notification.service';
import { GrantPageViewDto } from './dto/page-grant.dto';
import {
  ClassifyPageDto,
  PageControlDto,
  RequestPageAccessDto,
  ReviewPageAccessDto,
  RevokePageAccessDto,
  RevokePageGrantDto,
  TransferPageOwnerDto,
} from './dto/page-control.dto';
import { LecAuthorizationService } from './lec-authorization.service';
import { LecPolicyClient } from './lec-policy.client';
import {
  accessRequestEnvelopeSchema,
  LecPrincipal,
  resourceEnvelopeSchema,
  reviewAccessEnvelopeSchema,
} from './lec-policy.types';

type ControlOperation = Awaited<ReturnType<LecPageControlService['operation']>>;

@Injectable()
export class LecPageControlService {
  private readonly logger = new Logger(LecPageControlService.name);

  constructor(
    private readonly pages: PageRepo,
    private readonly authorization: LecAuthorizationService,
    private readonly policy: LecPolicyClient,
    private readonly notifications: NotificationService,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  async classify(actor: User, input: ClassifyPageDto) {
    return this.control(actor, input, 'doc-control/classify', {
      classification: input.classification,
    });
  }

  async transferOwner(actor: User, input: TransferPageOwnerDto) {
    return this.control(actor, input, 'doc-control/transfer-owner', {
      owner_user_id: input.ownerUserId,
    });
  }

  async revokeGrant(actor: User, input: RevokePageGrantDto) {
    return this.control(actor, input, 'doc-control/revoke-grant', {
      grant_id: input.grantId,
    });
  }

  async requestAccess(actor: User, input: RequestPageAccessDto) {
    const { page, principal } = await this.context(actor, input.pageId);
    const reason = input.reason.trim();
    if (!reason || [...reason].length > 1000)
      throw new BadRequestException({
        code: 'DOC_INVALID_REQUEST',
        message: '文档请求格式无效',
      });
    return this.strictCommand(
      'doc-control/request-access',
      {
        ...this.identity(page, principal),
        reason,
      },
      accessRequestEnvelopeSchema,
    );
  }

  async reviewAccess(actor: User, input: ReviewPageAccessDto) {
    const { page, principal } = await this.context(actor, input.pageId);
    return this.strictCommand(
      'doc-control/review-access',
      {
        ...this.identity(page, principal),
        expected_version: input.expectedVersion,
        operation_id: input.operationId,
        access_request_id: input.accessRequestId,
        decision: input.decision,
        expires_at:
          input.decision === 'APPROVE' ? input.expiresAt?.toISOString() : null,
      },
      reviewAccessEnvelopeSchema,
    );
  }

  async revokeAccess(actor: User, input: RevokePageAccessDto) {
    return this.control(actor, input, 'doc-control/revoke-access', {
      access_request_id: input.accessRequestId,
    });
  }

  private async control(
    actor: User,
    input: PageControlDto,
    path:
      | 'doc-control/classify'
      | 'doc-control/transfer-owner'
      | 'doc-control/revoke-grant'
      | 'doc-control/review-access'
      | 'doc-control/revoke-access',
    command: Record<string, unknown>,
  ) {
    const { page, principal } = await this.context(actor, input.pageId);
    return this.strictCommand(
      path,
      {
        ...this.identity(page, principal),
        expected_version: input.expectedVersion,
        operation_id: input.operationId,
        ...command,
      },
      resourceEnvelopeSchema,
    );
  }

  private async strictCommand<T>(
    path: Parameters<LecPolicyClient['send']>[0],
    payload: unknown,
    schema: z.ZodType<{ data: T }>,
  ): Promise<T> {
    try {
      return (await this.policy.send(path, payload, schema)).data;
    } catch (error) {
      if (
        error instanceof HttpException &&
        [400, 403, 409].includes(error.getStatus())
      )
        throw error;
      throw this.unavailable();
    }
  }

  private async context(actor: User, pageId: string) {
    const page = await this.pages.findAuthorizationSubject(pageId);
    if (!page || page.deletedAt || page.workspaceId !== actor.workspaceId)
      throw new NotFoundException('Page not found');
    const principal = await this.authorization.principal(
      actor,
      page.workspaceId,
    );
    if (principal.type !== 'OIDC') this.authorization.deny();
    return { page, principal };
  }

  private unavailable() {
    return new ServiceUnavailableException({
      code: 'DOC_AUTHORIZATION_UNAVAILABLE',
      message: '文档授权暂不可用，请稍后重试',
    });
  }

  private identity(
    page: { id: string; workspaceId: string },
    principal: Extract<LecPrincipal, { type: 'OIDC' }>,
  ) {
    return {
      request_id: randomUUID(),
      workspace_id: page.workspaceId,
      principal,
      resource_kind: 'DOCMOST_PAGE' as const,
      resource_id: page.id,
    };
  }

  async grantView(actor: User, input: GrantPageViewDto) {
    const { page, principal } = await this.context(actor, input.pageId);
    const recipientIssuer = new URL(input.subjectIssuer).href;
    const recipient = await this.db
      .selectFrom('lecIdentities')
      .innerJoin('users', 'users.id', 'lecIdentities.userId')
      .select('users.id')
      .where('lecIdentities.workspaceId', '=', page.workspaceId)
      .where('lecIdentities.issuer', '=', recipientIssuer)
      .where('lecIdentities.subject', '=', input.subject)
      .where('users.deletedAt', 'is', null)
      .where('users.deactivatedAt', 'is', null)
      .executeTakeFirst();
    if (!recipient) this.authorization.deny();

    const now = new Date();
    await this.db
      .insertInto('lecPageControlOperations')
      .values({
        id: input.operationId,
        workspaceId: page.workspaceId,
        pageId: page.id,
        spaceId: page.spaceId,
        action: 'GRANT_VIEW',
        status: 'CORE_PENDING',
        actorUserId: actor.id,
        actorIssuer: principal.issuer,
        actorSubject: principal.subject,
        recipientUserId: recipient.id,
        recipientIssuer,
        recipientSubject: input.subject,
        expectedVersion: String(input.expectedVersion),
        expiresAt: input.expiresAt ?? null,
        availableAt: now,
        updatedAt: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    const operation = await this.operation(input.operationId);
    if (operation.status === 'FAILED')
      throw new ConflictException('control operation failed');
    if (
      operation.workspaceId !== page.workspaceId ||
      operation.pageId !== page.id ||
      operation.spaceId !== page.spaceId ||
      operation.actorIssuer !== principal.issuer ||
      operation.actorSubject !== principal.subject ||
      operation.recipientIssuer !== recipientIssuer ||
      operation.recipientSubject !== input.subject ||
      operation.expectedVersion !== String(input.expectedVersion) ||
      operation.expiresAt?.getTime() !== input.expiresAt?.getTime()
    )
      throw new ConflictException('control operation idempotency conflict');

    await this.advance(operation);
    const settled = await this.operation(operation.id);
    return {
      operationId: operation.id,
      status:
        settled.status === 'DONE'
          ? ('DONE' as const)
          : ('LOCAL_PENDING' as const),
    };
  }

  @Interval('lec-page-control-reconciliation', 5_000)
  async reconcile() {
    const candidates = await this.db
      .selectFrom('lecPageControlOperations')
      .select('id')
      .where('status', 'in', [
        'CORE_PENDING',
        'LOCAL_PENDING',
        'NOTIFICATION_PENDING',
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
    for (const candidate of candidates) {
      try {
        await this.advance(await this.operation(candidate.id));
      } catch (error) {
        this.logger.error(
          `Page control reconciliation failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
  }

  private async advance(operation: NonNullable<ControlOperation>) {
    try {
      if (operation.status === 'CORE_PENDING') {
        await this.policy.send(
          'doc-control/grant',
          {
            request_id: randomUUID(),
            workspace_id: operation.workspaceId,
            principal: {
              type: 'OIDC',
              issuer: operation.actorIssuer,
              subject: operation.actorSubject,
            },
            resource_kind: 'DOCMOST_PAGE',
            resource_id: operation.pageId,
            expected_version: Number(operation.expectedVersion),
            operation_id: operation.id,
            subject_type: 'USER',
            subject_issuer: operation.recipientIssuer,
            subject: operation.recipientSubject,
            expires_at: operation.expiresAt?.toISOString() ?? null,
          },
          resourceEnvelopeSchema,
        );
        await this.db
          .updateTable('lecPageControlOperations')
          .set({ status: 'LOCAL_PENDING', updatedAt: new Date() })
          .where('id', '=', operation.id)
          .where('status', '=', 'CORE_PENDING')
          .execute();
        operation.status = 'LOCAL_PENDING';
      }

      if (operation.status === 'LOCAL_PENDING') {
        if (!operation.actorUserId || !operation.recipientUserId)
          throw new ForbiddenException();
        const projection = await this.db
          .selectFrom('lecPageGrantProjections')
          .select('grantId')
          .where('grantId', '=', operation.id)
          .where('pageId', '=', operation.pageId)
          .where('userId', '=', operation.recipientUserId)
          .where('revokedAt', 'is', null)
          .executeTakeFirst();
        if (!projection) {
          await this.recordFailure(operation, this.unavailable());
          return;
        }
        await this.db
          .updateTable('lecPageControlOperations')
          .set({
            status: 'NOTIFICATION_PENDING',
            localPageAccessId: null,
            updatedAt: new Date(),
          })
          .where('id', '=', operation.id)
          .where('status', '=', 'LOCAL_PENDING')
          .execute();
        operation.status = 'NOTIFICATION_PENDING';
      }

      if (operation.status === 'NOTIFICATION_PENDING') {
        if (!operation.actorUserId || !operation.recipientUserId)
          throw new ForbiddenException();
        await this.notifications.create({
          id: operation.id,
          userId: operation.recipientUserId,
          workspaceId: operation.workspaceId,
          type: NotificationType.PAGE_PERMISSION_GRANTED,
          actorId: operation.actorUserId,
          pageId: operation.pageId,
          spaceId: operation.spaceId,
          data: { role: 'reader' },
        });
        await this.db
          .updateTable('lecPageControlOperations')
          .set({
            status: 'DONE',
            leaseUntil: null,
            lastErrorCode: null,
            updatedAt: new Date(),
          })
          .where('id', '=', operation.id)
          .where('status', '=', 'NOTIFICATION_PENDING')
          .execute();
      }
    } catch (error) {
      await this.recordFailure(operation, error);
      throw error;
    }
  }

  private async operation(id: string) {
    const operation = await this.db
      .selectFrom('lecPageControlOperations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!operation) throw new ConflictException('control operation missing');
    return operation;
  }

  private async recordFailure(
    operation: NonNullable<ControlOperation>,
    error: unknown,
  ) {
    const terminal =
      error instanceof BadRequestException ||
      error instanceof ConflictException ||
      error instanceof ForbiddenException ||
      (error instanceof HttpException && error.getStatus() === 400);
    const attempts = operation.attempts + 1;
    await this.db
      .updateTable('lecPageControlOperations')
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
}
