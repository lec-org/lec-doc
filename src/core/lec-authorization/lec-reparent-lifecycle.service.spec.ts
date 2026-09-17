import { ConflictException } from '@nestjs/common';
import { LecResourceLifecycleService } from './lec-resource-lifecycle.service';

const workspaceId = '10000000-0000-4000-8000-000000000001';
const userId = '20000000-0000-4000-8000-000000000001';
const pageId = '30000000-0000-4000-8000-000000000001';
const parentId = '40000000-0000-4000-8000-000000000001';
const user = { id: userId, workspaceId };
const principal = {
  type: 'OIDC' as const,
  issuer: 'https://issuer.example.test',
  subject: 'actor',
};

function fixture() {
  let row: any;
  const query: any = {
    values: jest.fn((value) => {
      row = { attempts: 0, leaseUntil: null, createdAt: new Date(), ...value };
      return query;
    }),
    selectAll: jest.fn(() => query),
    where: jest.fn(() => query),
    orderBy: jest.fn(() => query),
    set: jest.fn((value) => {
      row = { ...row, ...value };
      return query;
    }),
    execute: jest.fn().mockResolvedValue([]),
    executeTakeFirst: jest.fn(async () => row),
    executeTakeFirstOrThrow: jest.fn(async () => row),
    returningAll: jest.fn(() => query),
  };
  const db: any = {
    insertInto: jest.fn(() => query),
    selectFrom: jest.fn(() => query),
    updateTable: jest.fn(() => query),
    transaction: jest.fn(() => ({
      execute: (callback: (trx: any) => unknown) => callback(db),
    })),
  };
  const send = jest.fn(async (_path, payload: any) => ({
    data: {
      workspace_id: workspaceId,
      resource_kind: 'DOCMOST_PAGE',
      resource_id: pageId,
      operation_id: row.id,
      operation_status:
        payload.action === 'PREPARE'
          ? 'PREPARED'
          : payload.action === 'COMMIT'
            ? 'COMMITTED'
            : 'CANCELLED',
    },
  }));
  return {
    service: new LecResourceLifecycleService(
      db,
      { send } as any,
      {} as any,
      {} as any,
    ),
    send,
    get row() {
      return row;
    },
  };
}

describe('reparent lifecycle', () => {
  it('cancels the prepared Core operation when Doc validation fails', async () => {
    const test = fixture();

    await expect(
      test.service.movePage(
        user,
        principal,
        pageId,
        7,
        'DOCMOST_PAGE',
        parentId,
        async () => {
          throw new ConflictException('Doc validation failed');
        },
      ),
    ).rejects.toThrow('Doc validation failed');

    expect(test.send.mock.calls.map(([, payload]) => payload.action)).toEqual([
      'PREPARE',
      'CANCEL',
    ]);
    expect(test.row.status).toBe('DONE');
  });

  it('commits Core only after the Doc transaction succeeds', async () => {
    const test = fixture();

    await expect(
      test.service.movePage(
        user,
        principal,
        pageId,
        7,
        'DOCMOST_PAGE',
        parentId,
        async () => 'moved',
      ),
    ).resolves.toBe('moved');

    expect(test.send.mock.calls.map(([, payload]) => payload.action)).toEqual([
      'PREPARE',
      'COMMIT',
    ]);
    expect(test.row.status).toBe('DONE');
  });
});
