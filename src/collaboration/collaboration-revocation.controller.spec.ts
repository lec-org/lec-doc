import { CollaborationRevocationController } from './collaboration-revocation.controller';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { EnvironmentService } from '../integrations/environment/environment.service';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';

const token = '0123456789abcdef0123456789abcdef';
const event = {
  event_id: '00000000-0000-4000-8000-000000000001',
  workspace_id: '10000000-0000-4000-8000-000000000001',
  resource_kind: 'DOCMOST_PAGE' as const,
  resource_id: '20000000-0000-4000-8000-000000000001',
  resource_version: 2,
};

type Row = {
  eventId: string;
  workspaceId: string;
  resourceKind: string;
  resourceId: string;
  resourceVersion: string;
  publishedAt: Date | null;
  supersededAt: Date | null;
  createdAt: Date;
};

function database(initial: Row[] = []) {
  const rows = [...initial];
  const matches = (row: Row, filters: any[][]) =>
    filters.every(([column, operator, value]) => {
      if (typeof column !== 'string') return true;
      const actual = row[column as keyof Row];
      if (operator === '=') return actual === value;
      if (operator === '>') return Number(actual) > Number(value);
      if (operator === 'is') return actual === value;
      return true;
    });
  return {
    rows,
    insertInto: jest.fn(() => {
      let value: any;
      const query: any = {
        values: jest.fn((candidate) => {
          value = candidate;
          return query;
        }),
        onConflict: jest.fn((callback) => {
          callback({ column: () => ({ doNothing: () => undefined }) });
          return query;
        }),
        execute: jest.fn(async () => {
          if (rows.some((row) => row.eventId === value.eventId)) return;
          rows.push({
            ...value,
            resourceVersion: String(value.resourceVersion),
            publishedAt: null,
            supersededAt: null,
            createdAt: new Date(),
          });
        }),
      };
      return query;
    }),
    selectFrom: jest.fn(() => {
      const filters: any[][] = [];
      const query: any = {
        select: jest.fn(() => query),
        selectAll: jest.fn(() => query),
        where: jest.fn((...args) => {
          filters.push(args);
          return query;
        }),
        orderBy: jest.fn(() => query),
        limit: jest.fn(() => query),
        executeTakeFirstOrThrow: jest.fn(async () => {
          const row = rows.find((candidate) => matches(candidate, filters));
          if (!row) throw new Error('missing row');
          return row;
        }),
        executeTakeFirst: jest.fn(async () =>
          rows.find((candidate) => matches(candidate, filters)),
        ),
        execute: jest.fn(async () =>
          rows.filter((candidate) => matches(candidate, filters)),
        ),
      };
      return query;
    }),
    updateTable: jest.fn(() => {
      const filters: any[][] = [];
      let value: Partial<Row>;
      const query: any = {
        set: jest.fn((candidate) => {
          value = candidate;
          return query;
        }),
        where: jest.fn((...args) => {
          filters.push(args);
          return query;
        }),
        execute: jest.fn(async () => {
          for (const row of rows.filter((candidate) =>
            matches(candidate, filters),
          ))
            Object.assign(row, value);
        }),
      };
      return query;
    }),
  };
}

function controller(db: ReturnType<typeof database>, publish = jest.fn()) {
  return new CollaborationRevocationController(
    { getOrThrow: jest.fn().mockReturnValue(token) } as any,
    { getOrThrow: jest.fn().mockReturnValue({ publish }) } as any,
    db as any,
  );
}

function request() {
  return { headers: { authorization: `Bearer ${token}` } } as any;
}

describe('Core collaboration revocations', () => {
  it('is exposed once at the contracted /api/internal route', async () => {
    const db = database();
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
    expect(db.rows).toHaveLength(1);
    await app.close();
  });

  it('replays a durably accepted event after immediate publication fails', async () => {
    const db = database();
    const publish = jest
      .fn()
      .mockRejectedValueOnce(new Error('redis unavailable'))
      .mockResolvedValue(1);
    const subject = controller(db, publish);

    await expect(subject.receive(request(), event)).rejects.toThrow(
      'redis unavailable',
    );
    expect(db.rows[0].publishedAt).toBeNull();

    await subject.replayUnpublished();

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith(
      'lec:doc:authorization:revocations',
      JSON.stringify(event),
    );
    expect(db.rows[0].publishedAt).toBeInstanceOf(Date);
  });

  it('deduplicates retries and suppresses stale out-of-order versions', async () => {
    const db = database();
    const publish = jest.fn().mockResolvedValue(1);
    const subject = controller(db, publish);
    const newer = {
      ...event,
      event_id: '00000000-0000-4000-8000-000000000003',
      resource_version: 3,
    };
    const stale = {
      ...event,
      event_id: '00000000-0000-4000-8000-000000000002',
      resource_version: 2,
    };

    await subject.receive(request(), newer);
    await subject.receive(request(), newer);
    await subject.receive(request(), stale);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(
      db.rows.find((row) => row.eventId === stale.event_id)?.supersededAt,
    ).toBeInstanceOf(Date);
  });

  it('rejects the wrong service credential', async () => {
    const subject = controller(database());
    await expect(
      subject.receive(
        { headers: { authorization: 'Bearer wrong' } } as any,
        event,
      ),
    ).rejects.toThrow('Unauthorized');
  });
});
