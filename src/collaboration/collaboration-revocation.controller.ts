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

const postgresUuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );

const eventSchema = z
  .object({
    event_id: postgresUuid,
    workspace_id: postgresUuid,
    resource_kind: z.enum(['DOCMOST_SPACE', 'DOCMOST_PAGE']),
    resource_id: postgresUuid,
    resource_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

type InboxEvent = {
  eventId: string;
  workspaceId: string;
  resourceKind: string;
  resourceId: string;
  resourceVersion: string;
};

@Controller('internal/core/revocations')
export class CollaborationRevocationController {
  private readonly logger = new Logger(CollaborationRevocationController.name);

  constructor(
    private readonly environment: EnvironmentService,
    private readonly redis: RedisService,
    @InjectKysely() private readonly db: KyselyDB,
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
      })
      .onConflict((conflict) => conflict.column('eventId').doNothing())
      .execute();
    const accepted = await this.db
      .selectFrom('lecCoreRevocationInbox')
      .selectAll()
      .where('eventId', '=', event.event_id)
      .executeTakeFirstOrThrow();
    if (
      accepted.workspaceId !== event.workspace_id ||
      accepted.resourceKind !== event.resource_kind ||
      accepted.resourceId !== event.resource_id ||
      Number(accepted.resourceVersion) !== event.resource_version
    )
      throw new UnauthorizedException();
    if (accepted.publishedAt || accepted.supersededAt) return;
    await this.publish(accepted);
  }

  @Interval('lec-core-revocation-replay', 1_000)
  async replayUnpublished() {
    try {
      const pending = await this.db
        .selectFrom('lecCoreRevocationInbox')
        .select([
          'eventId',
          'workspaceId',
          'resourceKind',
          'resourceId',
          'resourceVersion',
        ])
        .where('publishedAt', 'is', null)
        .where('supersededAt', 'is', null)
        .orderBy('createdAt', 'asc')
        .limit(20)
        .execute();
      for (const event of pending) await this.publish(event);
    } catch (error) {
      this.logger.error(
        `Core revocation replay failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private async publish(event: InboxEvent) {
    const newer = await this.db
      .selectFrom('lecCoreRevocationInbox')
      .select('eventId')
      .where('workspaceId', '=', event.workspaceId)
      .where('resourceKind', '=', event.resourceKind)
      .where('resourceId', '=', event.resourceId)
      .where('resourceVersion', '>', event.resourceVersion)
      .executeTakeFirst();
    if (newer) return this.mark(event.eventId, { supersededAt: new Date() });

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
    await this.mark(event.eventId, { publishedAt: new Date() });
  }

  private mark(
    eventId: string,
    value: { publishedAt: Date } | { supersededAt: Date },
  ) {
    return this.db
      .updateTable('lecCoreRevocationInbox')
      .set(value)
      .where('eventId', '=', eventId)
      .execute();
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
