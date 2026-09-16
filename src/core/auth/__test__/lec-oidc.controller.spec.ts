import { ThrottlerModule } from '@nestjs/throttler';
import { AUTH_THROTTLER } from '../../../integrations/throttle/throttler-names';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { ConfigService } from '@nestjs/config';
import { LecOidcController } from '../lec-oidc.controller';
import { LecOidcClient } from '../lec-oidc.client';
import { LecOidcTransactions } from '../lec-oidc-transactions';
import { LecIdentityService } from '../lec-identity.service';
import { LecBrowserSecurity } from '../lec-browser-security';
import { SessionService } from '../../session/session.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { User } from '../../../database/types/entity.types';

describe('OIDC HTTP 入口', () => {
  let app: NestFastifyApplication;
  const state = 's'.repeat(43);
  const transactions = { save: jest.fn(), consume: jest.fn() };
  const oidc = {
    begin: jest.fn().mockResolvedValue({
      url: 'https://sso.example.test/auth',
      transaction: { state, nonce: 'n'.repeat(43), verifier: 'v'.repeat(43) },
    }),
    complete: jest.fn(),
  };
  beforeEach(async () => {
    jest.clearAllMocks();
    const environment = new EnvironmentService(
      new ConfigService({
        APP_URL: 'https://doc.example.test',
        APP_SECRET: 'test-only-controller-secret-32-characters',
      }),
    );
    const module = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          { name: AUTH_THROTTLER, ttl: 60000, limit: 5 },
        ]),
      ],
      controllers: [LecOidcController],
      providers: [
        { provide: LecOidcClient, useValue: oidc },
        { provide: LecOidcTransactions, useValue: transactions },
        { provide: LecIdentityService, useValue: { resolve: jest.fn() } },
        {
          provide: SessionService,
          useValue: { rotateSessionAndToken: jest.fn() },
        },
        { provide: EnvironmentService, useValue: environment },
        {
          provide: LecBrowserSecurity,
          useValue: new LecBrowserSecurity(environment),
        },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api');
    await app.register(fastifyCookie);
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onRequest', async (req) => {
        Object.assign(req.raw, { workspace: { id: 'workspace-1' } });
      });
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });

  it('登录只重定向 IdP，将随机浏览器绑定放入 Secure HttpOnly Cookie', async () => {
    const response = await app.inject({ url: '/api/auth/oidc/login' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('https://sso.example.test/auth');
    const cookie = response.cookies.find(
      (item) => item.name === `lecOidc_${state}`,
    );
    expect(cookie).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      path: '/api/auth/oidc/callback',
      maxAge: 300,
    });
    expect(transactions.save).toHaveBeenCalledWith(
      'workspace-1',
      cookie.value,
      expect.objectContaining({ state }),
    );
    expect(response.body).not.toContain('verifier');
  });

  it('登录与回调共用认证限流，超出限制不再创建事务', async () => {
    for (let attempt = 0; attempt < 5; attempt++)
      await app.inject({ url: '/api/auth/oidc/login' });
    expect((await app.inject({ url: '/api/auth/oidc/login' })).statusCode).toBe(
      429,
    );
    expect(transactions.save).toHaveBeenCalledTimes(5);
  });

  it('callback 消费绑定后换取身份并轮换会话，token 仅放入 HttpOnly Cookie', async () => {
    const transaction = {
      state,
      nonce: 'n'.repeat(43),
      verifier: 'v'.repeat(43),
    };
    transactions.consume.mockResolvedValue(transaction);
    oidc.complete.mockResolvedValue({
      issuer: 'https://sso.example.test',
      subject: 'subject-1',
      email: 'user@example.test',
      name: '测试用户',
    });
    const user = { id: 'user-1', workspaceId: 'workspace-1' } as User;
    jest.spyOn(app.get(LecIdentityService), 'resolve').mockResolvedValue(user);
    const rotate = jest
      .spyOn(app.get(SessionService), 'rotateSessionAndToken')
      .mockResolvedValue('private-new-session');
    const response = await app.inject({
      url: `/api/auth/oidc/callback?code=private-code&state=${state}`,
      cookies: {
        [`lecOidc_${state}`]: 'browser-binding',
        authToken: 'private-old-session',
      },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/');
    expect(transactions.consume).toHaveBeenCalledWith(
      'workspace-1',
      'browser-binding',
      state,
    );
    expect(rotate).toHaveBeenCalledWith(user, 'private-old-session');
    expect(
      response.cookies.find((cookie) => cookie.name === 'authToken'),
    ).toMatchObject({
      value: 'private-new-session',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
    });
    expect(
      response.cookies.find((cookie) => cookie.name === 'lecCsrf'),
    ).toMatchObject({ secure: true, sameSite: 'Lax', path: '/' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toMatch(/private-code|private-new-session/);
  });
});
