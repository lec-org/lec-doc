import { JwtService } from '@nestjs/jwt';
import { ClsService } from 'nestjs-cls';
import { TokenService } from '../services/token.service';
import { SessionService } from '../../session/session.service';
import { CamelCasePlugin, Dialect, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres = require('postgres');
import { randomUUID } from 'node:crypto';
import { KyselyDB } from '../../../database/types/kysely.types';
import { UserRepo } from '../../../database/repos/user/user.repo';
import { GroupRepo } from '../../../database/repos/group/group.repo';
import { GroupUserRepo } from '../../../database/repos/group/group-user.repo';
import { LecIdentityService } from '../lec-identity.service';
import { JwtStrategy } from '../strategies/jwt.strategy';
import { WorkspaceRepo } from '../../../database/repos/workspace/workspace.repo';
import { UserSessionRepo } from '../../../database/repos/session/user-session.repo';
import { SessionActivityService } from '../../session/session-activity.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { ConfigService } from '@nestjs/config';
import { JwtType } from '../dto/jwt-payload';

const url = process.env.LEC_DOC_TEST_DATABASE_URL;
(url ? describe : describe.skip)('真实 PostgreSQL 的稳定 OIDC identity', () => {
  let db: KyselyDB;
  let users: UserRepo;
  let memberships: GroupUserRepo;
  let identities: LecIdentityService;
  let workspaceId: string;
  let groupId: string;
  const principal = {
    issuer: 'https://sso.example.test/oidc',
    subject: 'subject-1',
    email: 'user@example.test',
    name: '测试用户',
  };

  beforeAll(() => {
    // 同版本 Kysely 的 ESM/CJS 声明带不同 private 品牌；实际使用同一驱动契约。
    db = new Kysely({
      dialect: new PostgresJSDialect({
        postgres: postgres(url, { max: 8 }),
      }) as unknown as Dialect,
      plugins: [new CamelCasePlugin()],
    });
    users = new UserRepo(db);
    memberships = new GroupUserRepo(db, new GroupRepo(db), users);
    identities = new LecIdentityService(db, users, memberships);
  });
  beforeEach(async () => {
    workspaceId = randomUUID();
    await db
      .insertInto('workspaces')
      .values({ id: workspaceId, name: 'OIDC 集成测试' })
      .execute();
    const group = await db
      .insertInto('groups')
      .values({ workspaceId, name: '所有成员', isDefault: true })
      .returning('id')
      .executeTakeFirstOrThrow();
    groupId = group.id;
  });
  afterEach(async () => {
    await db.deleteFrom('workspaces').where('id', '=', workspaceId).execute();
  });
  afterAll(async () => {
    await db.destroy();
  });

  it('按 issuer/sub 创建 passwordless 用户和默认组，重登使用相同用户', async () => {
    const first = await identities.resolve(workspaceId, principal);
    const again = await identities.resolve(workspaceId, {
      ...principal,
      name: '新名称',
    });
    expect(again.id).toBe(first.id);
    const saved = await users.findById(first.id, workspaceId, {
      includePassword: true,
    });
    expect(saved.password).toBeNull();
    expect(saved.workspaceId).toBe(workspaceId);
    expect(saved.role).toBe('member');
    expect(await memberships.getGroupUserById(first.id, groupId)).toBeDefined();
  });

  it('八个并发首次登录只得到同一个账号', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        identities.resolve(workspaceId, principal),
      ),
    );
    expect(new Set(results.map((user) => user.id)).size).toBe(1);
    expect(await memberships.getUserGroupIds(results[0].id)).toEqual([groupId]);
  });

  it('同一稳定主体修改邮箱不会创建第二个账号；相同邮箱不能跨 subject 合并', async () => {
    const first = await identities.resolve(workspaceId, principal);
    const updated = await identities.resolve(workspaceId, {
      ...principal,
      email: 'changed@example.test',
    });
    expect(updated.id).toBe(first.id);
    expect(updated.email).toBe('changed@example.test');
    await expect(
      identities.resolve(workspaceId, {
        ...principal,
        email: updated.email,
        subject: 'another-subject',
      }),
    ).rejects.toThrow('不会自动合并账号');
  });

  it('已有本地账号的邮箱冲突必须显式绑定', async () => {
    await users.insertUser({
      email: principal.email,
      password: 'test-password-only',
      workspaceId,
    });
    await expect(identities.resolve(workspaceId, principal)).rejects.toThrow(
      '不会自动合并账号',
    );
  });

  it.each(['deactivatedAt', 'deletedAt'] as const)(
    '稳定 identity 不会复活 %s 账号',
    async (field) => {
      const user = await identities.resolve(workspaceId, principal);
      await users.updateUser({ [field]: new Date() }, user.id, workspaceId);
      await expect(identities.resolve(workspaceId, principal)).rejects.toThrow(
        '账号已停用',
      );
    },
  );

  it('默认组写入失败时回滚用户创建和 identity，不留下阻止重试的半成品', async () => {
    await db.deleteFrom('groups').where('id', '=', groupId).execute();
    await expect(identities.resolve(workspaceId, principal)).rejects.toThrow();
    await db
      .insertInto('groups')
      .values({ id: groupId, workspaceId, name: '所有成员', isDefault: true })
      .execute();
    const recovered = await identities.resolve(workspaceId, principal);
    expect(
      await memberships.getGroupUserById(recovered.id, groupId),
    ).toBeDefined();
  });

  it('旧版无 sessionId 的 JWT 不能继续作为登录态', async () => {
    const user = await identities.resolve(workspaceId, principal);
    const strategy = new JwtStrategy(
      users,
      new WorkspaceRepo(db),
      new UserSessionRepo(db),
      { trackActivity: () => {} } as unknown as SessionActivityService,
      new EnvironmentService(
        new ConfigService({
          APP_SECRET: 'test-only-session-secret-32-characters',
        }),
      ),
      identities,
    );
    await expect(
      strategy.validate(
        { raw: {} },
        { sub: user.id, email: user.email, workspaceId, type: JwtType.ACCESS },
      ),
    ).rejects.toThrow();
  });

  it('本地有效 session 缺少 OIDC identity 时不能进入受保护接口', async () => {
    const user = await users.insertUser({
      email: principal.email,
      password: 'test-only-password',
      workspaceId,
    });
    const sessions = new UserSessionRepo(db);
    const session = await sessions.insertSession({
      userId: user.id,
      workspaceId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const strategy = new JwtStrategy(
      users,
      new WorkspaceRepo(db),
      sessions,
      { trackActivity: () => {} } as unknown as SessionActivityService,
      new EnvironmentService(
        new ConfigService({
          APP_SECRET: 'test-only-session-secret-32-characters',
        }),
      ),
      identities,
    );
    await expect(
      strategy.validate(
        { raw: {} },
        {
          sub: user.id,
          email: user.email,
          workspaceId,
          type: JwtType.ACCESS,
          sessionId: session.id,
        },
      ),
    ).rejects.toThrow();
  });
  it('真实会话轮换撤销旧会话；撤销存储失败不能签发新会话', async () => {
    const user = await identities.resolve(workspaceId, principal);
    const secret = 'test-only-session-rotation-secret-32-characters';
    const environment = new EnvironmentService(
      new ConfigService({ APP_SECRET: secret }),
    );
    const tokens = new TokenService(
      new JwtService({ secret, signOptions: { expiresIn: '1h' } }),
      environment,
    );
    const repo = new UserSessionRepo(db);
    const sessions = new SessionService(tokens, repo, environment, {
      get: () => undefined,
    } as unknown as ClsService);
    const first = await sessions.createSessionAndToken(user);
    const firstPayload = await tokens.verifyJwt(first, JwtType.ACCESS);
    const second = await sessions.rotateSessionAndToken(user, first);
    const secondPayload = await tokens.verifyJwt(second, JwtType.ACCESS);
    expect(secondPayload.sessionId).not.toBe(firstPayload.sessionId);
    expect(await repo.findActiveById(firstPayload.sessionId)).toBeUndefined();
    expect(await repo.findActiveById(secondPayload.sessionId)).toBeDefined();
    const failure = jest
      .spyOn(repo, 'revokeById')
      .mockRejectedValueOnce(new Error('database unavailable'));
    const before = await repo.findActiveByUser(user.id, workspaceId);
    await expect(sessions.rotateSessionAndToken(user, second)).rejects.toThrow(
      'database unavailable',
    );
    expect(await repo.findActiveByUser(user.id, workspaceId)).toHaveLength(
      before.length,
    );
    failure.mockRestore();
    await sessions.revokeSession(secondPayload.sessionId, user.id, workspaceId);
    expect(await repo.findActiveById(secondPayload.sessionId)).toBeUndefined();
  });
});
