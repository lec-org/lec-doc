import { CollaborationRevocationController } from './collaboration-revocation.controller';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { EnvironmentService } from '../integrations/environment/environment.service';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { EntitlementProjectionService } from './entitlement-projection.service';

const token = '0123456789abcdef0123456789abcdef';
const event = {
  event_id: '00000000-0000-4000-8000-000000000001',
  workspace_id: '10000000-0000-4000-8000-000000000001',
  resource_kind: 'DOCMOST_PAGE' as const,
  resource_id: '20000000-0000-4000-8000-000000000001',
  resource_version: 2,
  effect: 'NONE' as const,
  entitlement_id: null,
  recipient_issuer: null,
  recipient_subject: null,
  expires_at: null,
};

function controller(
  db: any,
  publish = jest.fn().mockResolvedValue(1),
  apply = jest.fn(),
) {
  return new CollaborationRevocationController(
    { getOrThrow: jest.fn().mockReturnValue(token) } as any,
    { getOrThrow: jest.fn().mockReturnValue({ publish }) } as any,
    db,
    { apply } as any,
  );
}

function request() {
  return { headers: { authorization: `Bearer ${token}` } } as any;
}

function query(row: any) {
  const q: any = {
    values: jest.fn(() => q),
    onConflict: jest.fn(() => q),
    select: jest.fn(() => q),
    selectAll: jest.fn(() => q),
    where: jest.fn(() => q),
    orderBy: jest.fn(() => q),
    limit: jest.fn(() => q),
    forUpdate: jest.fn(() => q),
    set: jest.fn(() => q),
    execute: jest.fn().mockResolvedValue([]),
    executeTakeFirst: jest.fn().mockResolvedValue(row),
    executeTakeFirstOrThrow: jest.fn().mockResolvedValue(row),
  };
  return q;
}

function database(row: any) {
  const q = query(row);
  const db: any = {
    insertInto: jest.fn(() => q),
    selectFrom: jest.fn(() => q),
    updateTable: jest.fn(() => q),
  };
  db.transaction = jest.fn(() => ({
    execute: async (callback: (trx: any) => unknown) => callback(db),
  }));
  return db;
}

function inbox(payload: any = event) {
  return {
    eventId: payload.event_id,
    workspaceId: payload.workspace_id,
    resourceKind: payload.resource_kind,
    resourceId: payload.resource_id,
    resourceVersion: String(payload.resource_version),
    effect: payload.effect,
    entitlementId: payload.entitlement_id,
    recipientIssuer: payload.recipient_issuer,
    recipientSubject: payload.recipient_subject,
    expiresAt: payload.expires_at ? new Date(payload.expires_at) : null,
    projectedAt: null,
    publishedAt: null,
    supersededAt: null,
    createdAt: new Date(),
  };
}

describe('Core collaboration revocations', () => {
  it('is exposed once at the contracted /api/internal route', async () => {
    const db = database(inbox());
    const module = await Test.createTestingModule({
      controllers: [CollaborationRevocationController],
      providers: [
        { provide: EnvironmentService, useValue: { getOrThrow: () => token } },
        {
          provide: RedisService,
          useValue: {
            getOrThrow: () => ({ publish: jest.fn().mockResolvedValue(1) }),
          },
        },
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        {
          provide: EntitlementProjectionService,
          useValue: { apply: jest.fn() },
        },
      ],
    }).compile();
    const app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api');
    await app.init();
    const response = await app.inject({
      method: 'POST',
      url: '/api/internal/core/revocations',
      headers: { authorization: `Bearer ${token}` },
      payload: event,
    });
    expect(response.statusCode).toBe(204);
    expect(db.insertInto).toHaveBeenCalledWith('lecCoreRevocationInbox');
    await app.close();
  });

  it('replays a durably accepted event after publication fails', async () => {
    const row = inbox();
    const db = database(row);
    const publish = jest
      .fn()
      .mockRejectedValueOnce(new Error('redis unavailable'))
      .mockResolvedValue(1);
    const subject = controller(db, publish);

    await expect(subject.receive(request(), event)).rejects.toThrow(
      'redis unavailable',
    );
    await (subject as any).publish(row);

    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('lets the projection CAS handle delayed versions instead of superseding by entitlement id', async () => {
    const row = inbox({
      ...event,
      effect: 'REVOKE_GRANT',
      entitlement_id: '30000000-0000-4000-8000-000000000001',
      recipient_issuer: 'https://id.example.test/oidc',
      recipient_subject: 'member-1',
    });
    const db = database(row);
    const apply = jest.fn();

    await (controller(db, undefined, apply) as any).apply(row);

    expect(apply).toHaveBeenCalledWith(db, row);
  });

  it('matches equivalent RFC3339 expiry spellings by instant', async () => {
    const expiring = {
      ...event,
      effect: 'UPSERT_ACCESS' as const,
      entitlement_id: '30000000-0000-4000-8000-000000000001',
      recipient_issuer: 'https://id.example.test/oidc',
      recipient_subject: 'member-1',
      expires_at: '2030-01-01T00:00:00Z',
    };
    const row = inbox({
      ...expiring,
      expires_at: '2030-01-01T00:00:00.000Z',
    });
    await expect(
      controller(database(row)).receive(request(), expiring),
    ).resolves.toBeUndefined();
  });

  it('rejects a duplicate event id with different semantic content', async () => {
    const db = database(inbox());
    await expect(
      controller(db).receive(request(), {
        ...event,
        resource_version: 3,
      }),
    ).rejects.toThrow('Unauthorized');
  });

  it('rejects the wrong service credential', async () => {
    const subject = controller(database(inbox()));
    await expect(
      subject.receive(
        { headers: { authorization: 'Bearer wrong' } } as any,
        event,
      ),
    ).rejects.toThrow('Unauthorized');
  });
});
