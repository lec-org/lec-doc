import {
  ConflictException,
  Controller,
  Get,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import {
  ALL_NAMED_THROTTLERS_SKIPPED,
  AUTH_THROTTLER,
} from '../../integrations/throttle/throttler-names';
import { FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { Workspace } from '@docmost/db/types/entity.types';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { LecOidcClient } from './lec-oidc.client';
import {
  LecOidcTransactions,
  OIDC_TRANSACTION_SECONDS,
} from './lec-oidc-transactions';
import { LecIdentityService } from './lec-identity.service';
import { SessionService } from '../session/session.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { LecBrowserSecurity } from './lec-browser-security';

@SkipThrottle({ ...ALL_NAMED_THROTTLERS_SKIPPED, [AUTH_THROTTLER]: false })
@UseGuards(ThrottlerGuard)
@Controller('auth/oidc')
export class LecOidcController {
  constructor(
    private readonly oidc: LecOidcClient,
    private readonly transactions: LecOidcTransactions,
    private readonly identities: LecIdentityService,
    private readonly sessions: SessionService,
    private readonly environment: EnvironmentService,
    private readonly security: LecBrowserSecurity,
  ) {}

  @Get('login')
  async login(@AuthWorkspace() workspace: Workspace, @Res() res: FastifyReply) {
    const { url, transaction } = await this.oidc.begin();
    const binding = randomBytes(32).toString('base64url');
    await this.transactions.save(workspace.id, binding, transaction);
    res
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer');
    res.setCookie(`lecOidc_${transaction.state}`, binding, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/api/auth/oidc/callback',
      maxAge: OIDC_TRANSACTION_SECONDS,
    });
    return res.redirect(url, 302);
  }

  @Get('callback')
  async callback(
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    res
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer');
    const url = new URL(req.originalUrl, this.environment.getAppUrl());
    const state = url.searchParams.get('state');
    if (
      url.searchParams.getAll('state').length !== 1 ||
      !/^[A-Za-z0-9_-]{43}$/.test(state ?? '')
    ) {
      throw new UnauthorizedException('登录请求已失效，请重新登录');
    }
    const name = `lecOidc_${state}`;
    res.clearCookie(name, {
      path: '/api/auth/oidc/callback',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
    try {
      const transaction = await this.transactions.consume(
        workspace.id,
        req.cookies[name],
        state,
      );
      const principal = await this.oidc.complete(url, transaction);
      const user = await this.identities.resolve(workspace.id, principal);
      const token = await this.sessions.rotateSessionAndToken(
        user,
        req.cookies.authToken,
      );
      const options = {
        secure: true,
        sameSite: 'lax' as const,
        path: '/',
        expires: this.environment.getCookieExpiresIn(),
      };
      res.setCookie('authToken', token, { ...options, httpOnly: true });
      res.setCookie('lecCsrf', this.security.issueCsrf(token), {
        ...options,
        httpOnly: false,
      });
      return res.redirect('/', 302);
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      // 不把上游响应、code、token 或底层异常写入客户端响应/日志。
      throw new UnauthorizedException('登录失败或请求已失效，请重新登录');
    }
  }
}
