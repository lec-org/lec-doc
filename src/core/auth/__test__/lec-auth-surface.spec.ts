import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ThrottlerGuard } from '@nestjs/throttler';
import { WorkspaceController } from '../../workspace/controllers/workspace.controller';
import { AuthController } from '../auth.controller';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { SetupGuard } from '../guards/setup.guard';

describe('Lec Doc 不提供本地密码认证入口', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AuthController, WorkspaceController],
    })
      .useMocker(() => ({}))
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SetupGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { logger: false },
    );
    app.setGlobalPrefix('api');
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  it('旧邀请注册不能绕过 OIDC 创建本地密码账号', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/workspace/invites/accept',
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });

  it.each([
    'login',
    'setup',
    'change-password',
    'forgot-password',
    'password-reset',
    'verify-token',
  ])('POST /auth/%s 已移除', async (route) => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/auth/${route}`,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });
});
