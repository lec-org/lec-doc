import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { CamelCasePlugin, Dialect, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres = require('postgres');
import { KyselyDB } from '../database/types/kysely.types';
import { BootstrapWorkspaceService } from './bootstrap-workspace.service';
import { LecBootstrapProfileClient } from './lec-bootstrap-profile.client';

const url = process.env.LEC_DOC_TEST_DATABASE_URL;
(url ? describe : describe.skip)('OIDC-only workspace bootstrap', () => {
  let db: KyselyDB;
  const workspaceId = randomUUID();
  const organizationId = randomUUID();
  const input = {
    workspaceId,
    workspaceName: 'Lec 文档',
    organizationId,
    defaultSpaceName: '常规',
    defaultSpaceSlug: 'general',
    ownerIssuer: 'https://id.example.test/oidc',
    ownerSubject: 'owner-subject',
    ownerEmail: 'owner@example.test',
    ownerName: '文档 Owner',
  };

  beforeAll(() => {
    db = new Kysely({
      dialect: new PostgresJSDialect({
        postgres: postgres(url, { max: 4 }),
      }) as unknown as Dialect,
      plugins: [new CamelCasePlugin()],
    });
  });

  afterEach(async () => {
    await db.transaction().execute(async (trx) => {
      const spaces = await trx
        .selectFrom('spaces')
        .select('id')
        .where('workspaceId', '=', workspaceId)
        .execute();
      const spaceIds = spaces.map(({ id }) => id);
      if (spaceIds.length)
        await trx
          .deleteFrom('spaceMembers')
          .where('spaceId', 'in', spaceIds)
          .execute();
      await trx
        .deleteFrom('workspaces')
        .where('id', '=', workspaceId)
        .execute();
    });
  });

  afterAll(async () => db.destroy());

  const ownerRealName = 'Core 实名';
  const profiles = {
    getOwnerRealName: jest.fn().mockResolvedValue(ownerRealName),
  } as unknown as LecBootstrapProfileClient;
  const service = () =>
    new BootstrapWorkspaceService(
      db,
      new ConfigService({
        LEC_DOC_ORGANIZATION_ID: organizationId,
        LEC_DOC_OIDC_ISSUER: input.ownerIssuer,
      }),
      profiles,
    );

  it('transactionally creates one passwordless owner, default group/space and durable Core bind intent', async () => {
    const result = await service().bootstrap(input);
    expect(result.created).toBe(true);

    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirstOrThrow();
    expect(user).toMatchObject({
      email: input.ownerEmail,
      name: input.ownerName,
      password: null,
      role: 'owner',
    });
    expect(
      await db
        .selectFrom('lecIdentities')
        .selectAll()
        .where('userId', '=', user.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      workspaceId,
      issuer: input.ownerIssuer,
      subject: input.ownerSubject,
    });
    const workspace = await db
      .selectFrom('workspaces')
      .selectAll()
      .where('id', '=', workspaceId)
      .executeTakeFirstOrThrow();
    expect(workspace.defaultSpaceId).toBe(result.spaceId);
    expect(
      await db
        .selectFrom('groupUsers')
        .select('userId')
        .where('userId', '=', user.id)
        .execute(),
    ).toHaveLength(1);
    expect(
      await db
        .selectFrom('spaceMembers')
        .select(['userId', 'groupId', 'role'])
        .where('spaceId', '=', result.spaceId)
        .execute(),
    ).toEqual([{ userId: user.id, groupId: null, role: 'admin' }]);
    expect(
      await db
        .selectFrom('spaces')
        .select(['name', 'isPersonal', 'isDefaultPersonal'])
        .where('id', '=', result.personalSpaceId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      name: ownerRealName,
      isPersonal: true,
      isDefaultPersonal: true,
    });
    expect(
      await db
        .selectFrom('lecResourceOperations')
        .select(['action', 'status', 'payload', 'actorUserId'])
        .where('resourceId', '=', result.spaceId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      action: 'BIND_SPACE',
      status: 'BIND_PENDING',
      payload: { organizationId },
      actorUserId: user.id,
    });
  });

  it('is idempotent for exact input and rejects every mismatch without mutation', async () => {
    const first = await service().bootstrap(input);
    await expect(service().bootstrap(input)).resolves.toEqual({
      ...first,
      created: false,
    });
    await expect(
      service().bootstrap({ ...input, ownerEmail: 'other@example.test' }),
    ).rejects.toThrow('does not match');
    await db
      .updateTable('lecResourceOperations')
      .set({ status: 'DONE' })
      .where('resourceId', '=', first.spaceId)
      .execute();
    await expect(service().bootstrap(input)).resolves.toEqual({
      ...first,
      created: false,
      coreBinding: 'done',
    });
    expect(
      await db.selectFrom('workspaces').select('id').execute(),
    ).toHaveLength(1);
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(1);
  });

  it('does not write when Core authoritative profile is unavailable', async () => {
    const unavailable = {
      getOwnerRealName: jest.fn().mockRejectedValue(new Error('unavailable')),
    } as unknown as LecBootstrapProfileClient;
    await expect(
      new BootstrapWorkspaceService(
        db,
        new ConfigService({
          LEC_DOC_ORGANIZATION_ID: organizationId,
          LEC_DOC_OIDC_ISSUER: input.ownerIssuer,
        }),
        unavailable,
      ).bootstrap(input),
    ).rejects.toThrow('unavailable');
    expect(await db.selectFrom('workspaces').select('id').execute()).toEqual(
      [],
    );
  });

  it('rejects mismatched deployment identity before mutation', async () => {
    await expect(
      new BootstrapWorkspaceService(
        db,
        new ConfigService({
          LEC_DOC_ORGANIZATION_ID: organizationId,
          LEC_DOC_OIDC_ISSUER: 'https://other.example.test/oidc',
        }),
        profiles,
      ).bootstrap(input),
    ).rejects.toThrow('issuer does not match');
    expect(await db.selectFrom('workspaces').select('id').execute()).toEqual(
      [],
    );
  });

  it('rejects a second workspace and rolls back a failed bootstrap', async () => {
    await service().bootstrap(input);
    await expect(
      service().bootstrap({ ...input, workspaceId: randomUUID() }),
    ).rejects.toThrow('does not match');

    const spaceId = await db
      .selectFrom('spaces')
      .select('id')
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirstOrThrow();
    await db
      .deleteFrom('spaceMembers')
      .where('spaceId', '=', spaceId.id)
      .execute();
    await db.deleteFrom('workspaces').where('id', '=', workspaceId).execute();
    await expect(
      service().bootstrap({ ...input, ownerSubject: '' }),
    ).rejects.toThrow();
    expect(await db.selectFrom('workspaces').select('id').execute()).toEqual(
      [],
    );
  });
});
