import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { FastifyRequest } from 'fastify';
import { EnvironmentService } from '../integrations/environment/environment.service';
import {
  REVOCATION_CHANNEL,
  RevocationEvent,
} from './collaboration-connection-registry.service';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { EntitlementProjectionService } from './entitlement-projection.service';

const postgresUuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
const commonEvent = {
  event_id: postgresUuid,
  workspace_id: postgresUuid,
  resource_kind: z.enum(['DOCMOST_SPACE', 'DOCMOST_PAGE']),
  resource_id: postgresUuid,
  resource_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
const eventSchema = z.discriminatedUnion('effect', [
  z.strictObject({
    ...commonEvent,
    effect: z.literal('NONE'),
    entitlement_id: z.null(),
    recipient_issuer: z.null(),
    recipient_subject: z.null(),
    expires_at: z.null(),
  }),
  z.strictObject({
    ...commonEvent,
    resource_kind: z.literal('DOCMOST_PAGE'),
    effect: z.literal('UPSERT_GRANT'),
    entitlement_id: postgresUuid,
    recipient_issuer: z.url(),
    recipient_subject: z.string().min(1).max(255),
    expires_at: z.iso.datetime().nullable(),
  }),
  z.strictObject({
    ...commonEvent,
    resource_kind: z.literal('DOCMOST_PAGE'),
    effect: z.literal('REVOKE_GRANT'),
    entitlement_id: postgresUuid,
    recipient_issuer: z.url(),
    recipient_subject: z.string().min(1).max(255),
    expires_at: z.null(),
  }),
  z.strictObject({
    ...commonEvent,
    resource_kind: z.literal('DOCMOST_PAGE'),
    effect: z.literal('UPSERT_ACCESS'),
    entitlement_id: postgresUuid,
    recipient_issuer: z.url(),
    recipient_subject: z.string().min(1).max(255),
    expires_at: z.iso.datetime(),
  }),
  z.strictObject({
    ...commonEvent,
    resource_kind: z.literal('DOCMOST_PAGE'),
    effect: z.literal('REVOKE_ACCESS'),
    entitlement_id: postgresUuid,
    recipient_issuer: z.url(),
    recipient_subject: z.string().min(1).max(255),
    expires_at: z.iso.datetime(),
  }),
]);
type ProjectionEvent = z.infer<typeof eventSchema>;

type InboxEvent = {
  eventId: string;
  workspaceId: string;
  resourceKind: string;
  resourceId: string;
  resourceVersion: string;
  effect: string;
  entitlementId: string | null;
  recipientIssuer: string | null;
  recipientSubject: string | null;
  expiresAt: Date | null;
  projectedAt: Date | null;
  publishedAt: Date | null;
};

@Controller('internal/core/revocations')
export class CollaborationRevocationController {
  private readonly logger = new Logger(CollaborationRevocationController.name);

  constructor(
    private readonly environment: EnvironmentService,
    private readonly redis: RedisService,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly projections: EntitlementProjectionService,
  ) {}

  @Post()
  @HttpCode(204)
  async receive(@Req() request: FastifyRequest, @Body() raw: unknown) {
    this.authenticate(request.headers.authorization);
    const event = eventSchema.parse(raw);
    await this.db
      .insertInto('lecCoreRevocationInbox')
      .values({
        eventId: event.event_id,
        workspaceId: event.workspace_id,
        resourceKind: event.resource_kind,
        resourceId: event.resource_id,
        resourceVersion: event.resource_version,
        effect: event.effect,
        entitlementId: event.entitlement_id,
        recipientIssuer: event.recipient_issuer,
        recipientSubject: event.recipient_subject,
        expiresAt: event.expires_at ? new Date(event.expires_at) : null,
      })
      .onConflict((conflict) => conflict.column('eventId').doNothing())
      .execute();
    const accepted = await this.db
      .selectFrom('lecCoreRevocationInbox')
      .selectAll()
      .where('eventId', '=', event.event_id)
      .executeTakeFirstOrThrow();
    if (!this.matches(accepted, event)) throw new UnauthorizedException();
    await this.apply(accepted);
    if (!accepted.publishedAt) await this.publish(accepted);
  }

  @Interval('lec-core-revocation-replay', 1_000)
  async replayUnpublished() {
    try {
      const pending = await this.db
        .selectFrom('lecCoreRevocationInbox')
        .selectAll()
        .where((eb) =>
          eb.or([
            eb('projectedAt', 'is', null),
            eb('publishedAt', 'is', null),
          ]),
        )
        .where('supersededAt', 'is', null)
        .orderBy('createdAt', 'asc')
        .limit(20)
        .execute();
      for (const event of pending) {
        try {
          await this.apply(event);
          if (!event.publishedAt) await this.publish(event);
        } catch (error) {
          this.logger.error(
            `Core revocation replay failed for ${event.eventId}: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Core revocation replay failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private async apply(event: InboxEvent) {
    if (event.projectedAt) return;
    await this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('lecCoreRevocationInbox')
        .selectAll()
        .where('eventId', '=', event.eventId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (current.projectedAt) return;
      if (current.effect !== 'NONE')
        await this.projections.apply(trx, current);
      await trx
        .updateTable('lecCoreRevocationInbox')
        .set({ projectedAt: new Date() })
        .where('eventId', '=', current.eventId)
        .execute();
    });
    event.projectedAt = new Date();
  }

  private async publish(event: InboxEvent) {
    const payload: RevocationEvent = {
      event_id: event.eventId,
      workspace_id: event.workspaceId,
      resource_kind: event.resourceKind as RevocationEvent['resource_kind'],
      resource_id: event.resourceId,
      resource_version: Number(event.resourceVersion),
    };
    await this.redis
      .getOrThrow()
      .publish(REVOCATION_CHANNEL, JSON.stringify(payload));
    await this.db
      .updateTable('lecCoreRevocationInbox')
      .set({ publishedAt: new Date() })
      .where('eventId', '=', event.eventId)
      .execute();
    event.publishedAt = new Date();
  }

  private matches(accepted: InboxEvent, event: ProjectionEvent) {
    return (
      accepted.workspaceId === event.workspace_id &&
      accepted.resourceKind === event.resource_kind &&
      accepted.resourceId === event.resource_id &&
      Number(accepted.resourceVersion) === event.resource_version &&
      accepted.effect === event.effect &&
      accepted.entitlementId === event.entitlement_id &&
      accepted.recipientIssuer === event.recipient_issuer &&
      accepted.recipientSubject === event.recipient_subject &&
      (accepted.expiresAt?.getTime() ?? null) ===
        (event.expires_at ? new Date(event.expires_at).getTime() : null)
    );
  }

  private authenticate(authorization?: string) {
    const token = this.environment.getOrThrow<string>(
      'LEC_DOC_REVOCATION_TOKEN',
    );
    const expected = Buffer.from(`Bearer ${token}`);
    const provided = Buffer.from(authorization ?? '');
    if (
      token.length < 32 ||
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    )
      throw new UnauthorizedException();
  }
}
