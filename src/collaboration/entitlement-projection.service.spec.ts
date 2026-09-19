import { EntitlementProjectionService } from './entitlement-projection.service';

const base = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  resourceId: '20000000-0000-4000-8000-000000000001',
  resourceVersion: '3',
  entitlementId: '30000000-0000-4000-8000-000000000001',
  recipientIssuer: 'https://id.example.test/oidc',
  recipientSubject: 'member-1',
  expiresAt: null,
};

function database() {
  const conflicts: string[] = [];
  const writes: string[] = [];
  let selected = '';
  const conflict: any = {
    columns: () => conflict,
    column: () => conflict,
    doUpdateSet: () => conflict,
    where: (_column: string, _operator: string, version: string) => {
      conflicts.push(version);
      return conflict;
    },
  };
  const query: any = {
    select: jest.fn(() => query),
    where: jest.fn(() => query),
    values: jest.fn(() => query),
    set: jest.fn(() => query),
    forUpdate: jest.fn(() => query),
    onConflict: jest.fn((callback) => {
      callback(conflict);
      return query;
    }),
    execute: jest.fn(async () => {
      writes.push(selected);
      return [];
    }),
    executeTakeFirst: jest.fn(async () =>
      selected === 'lecIdentities' ? { userId: 'user-1' } : undefined,
    ),
  };
  return {
    conflicts,
    writes,
    selectFrom: jest.fn((table) => {
      selected = table;
      return query;
    }),
    insertInto: jest.fn((table) => {
      selected = table;
      return query;
    }),
    updateTable: jest.fn((table) => {
      selected = table;
      return query;
    }),
  } as any;
}

describe('entitlement projections', () => {
  it('guards grant upserts with the incoming source version', async () => {
    const db = database();
    await new EntitlementProjectionService().apply(db, {
      ...base,
      effect: 'UPSERT_GRANT',
    });
    expect(db.conflicts).toContain('3');
    expect(db.insertInto).toHaveBeenCalledWith('lecPageGrantProjections');
  });

  it('creates an exact grant tombstone when revoke arrives first', async () => {
    const db = database();
    await new EntitlementProjectionService().apply(db, {
      ...base,
      effect: 'REVOKE_GRANT',
    });
    expect(db.insertInto).toHaveBeenCalledWith('lecPageGrantProjections');
    expect(db.insertInto).not.toHaveBeenCalledWith(
      'lecPageAccessProjections',
    );
  });

  it('does not let revoking an old grant replace a newer grant', async () => {
    const db = database();
    const query = db.selectFrom('lecPageGrantProjections');
    query.executeTakeFirst.mockResolvedValueOnce({
      grantId: '40000000-0000-4000-8000-000000000001',
      sourceVersion: '4',
    });
    await new EntitlementProjectionService().apply(db, {
      ...base,
      resourceVersion: '5',
      effect: 'REVOKE_GRANT',
    });
    expect(db.updateTable).not.toHaveBeenCalled();
  });

  it('requires an expiry for approved-access projections', async () => {
    await expect(
      new EntitlementProjectionService().apply(database(), {
        ...base,
        effect: 'UPSERT_ACCESS',
      }),
    ).rejects.toThrow('Unauthorized');
  });
});
