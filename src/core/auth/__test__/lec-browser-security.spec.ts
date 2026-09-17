import Fastify, { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { ConfigService } from '@nestjs/config';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { LecBrowserSecurity } from '../lec-browser-security';

describe('浏览器请求边界', () => {
  let app: FastifyInstance;
  let security: LecBrowserSecurity;
  let writes: number;
  beforeEach(async () => {
    writes = 0;
    security = new LecBrowserSecurity(
      new EnvironmentService(
        new ConfigService({
          APP_URL: 'https://doc.example.test',
          APP_SECRET: 'test-only-browser-csrf-secret-32-characters',
        }),
      ),
    );
    app = Fastify();
    security.install(app);
    await app.register(fastifyCookie);
    app.post('/change', () => ({ writes: ++writes }));
    app.post('/api/internal/core/revocations', () => ({ writes: ++writes }));
    app.get('/read', () => ({ ok: true }));
  });
  afterEach(async () => {
    await app.close();
  });

  it('只有精确 Origin 和绑定当前会话的双提交 CSRF 才能执行写操作', async () => {
    const csrf = security.issueCsrf('session-a');
    const response = await app.inject({
      method: 'POST',
      url: '/change',
      headers: { origin: 'https://doc.example.test', 'x-lec-csrf': csrf },
      cookies: { authToken: 'session-a', lecCsrf: csrf },
    });
    expect(response.statusCode).toBe(200);
    expect(writes).toBe(1);
    const replay = await app.inject({
      method: 'POST',
      url: '/change',
      headers: { origin: 'https://doc.example.test', 'x-lec-csrf': csrf },
      cookies: { authToken: 'session-b', lecCsrf: csrf },
    });
    expect(replay.statusCode).toBe(403);
    expect(writes).toBe(1);
  });

  it('服务间撤权 POST 没有浏览器 Origin 也能到达 bearer 认证控制器', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/internal/core/revocations',
    });
    expect(response.statusCode).toBe(200);
    expect(writes).toBe(1);
  });

  it.each([
    undefined,
    'null',
    'https://doc.example.test.evil',
    'https://doc.example.test:444',
    'https://doc.example.test/',
  ])('浏览器写请求拒绝 Origin %s，处理器不执行', async (origin) => {
    const csrf = security.issueCsrf('session-a');
    const response = await app.inject({
      method: 'POST',
      url: '/change',
      headers: {
        ...(origin === undefined ? {} : { origin }),
        'x-lec-csrf': csrf,
      },
      cookies: { authToken: 'session-a', lecCsrf: csrf },
    });
    expect(response.statusCode).toBe(403);
    expect(writes).toBe(0);
  });

  it.each(['missing', 'different', 'forged'])(
    '拒绝 %s CSRF 双提交',
    async (kind) => {
      const csrf = security.issueCsrf('session-a');
      const header =
        kind === 'missing'
          ? undefined
          : kind === 'different'
            ? security.issueCsrf('session-a')
            : `${csrf.slice(0, 44)}${'A'.repeat(43)}`;
      const response = await app.inject({
        method: 'POST',
        url: '/change',
        headers: {
          origin: 'https://doc.example.test',
          ...(header ? { 'x-lec-csrf': header } : {}),
        },
        cookies: {
          authToken: 'session-a',
          lecCsrf: kind === 'forged' ? header : csrf,
        },
      });
      expect(response.statusCode).toBe(403);
      expect(writes).toBe(0);
    },
  );

  it('普通 GET 导航允许缺少 Origin；显式跨域 GET 和缺少 Origin 的 WS 拒绝', async () => {
    expect((await app.inject('/read')).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          url: '/read',
          headers: { origin: 'https://evil.example.test' },
        })
      ).statusCode,
    ).toBe(403);
    expect(() => security.assertOrigin(undefined, true)).toThrow();
  });
});
