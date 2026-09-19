import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { FastifyReply, FastifyRequest } from 'fastify';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { Workspace } from '@docmost/db/types/entity.types';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { LecBrowserSecurity } from './lec-browser-security';
import { LecDesktopHandoffService } from './lec-desktop-handoff.service';
import { LecIdentityService } from './lec-identity.service';
import { LecCoreProfileClient } from './lec-core-profile.client';
import { LecOidcClient } from './lec-oidc.client';
import { SessionService } from '../session/session.service';

class DesktopHandoffDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  accountGeneration: string;
}

@Controller('auth/desktop-handoff')
export class LecDesktopHandoffController {
  constructor(
    private readonly oidc: LecOidcClient,
    private readonly handoffs: LecDesktopHandoffService,
    private readonly identities: LecIdentityService,
    private readonly coreProfile: LecCoreProfileClient,
    private readonly sessions: SessionService,
    private readonly environment: EnvironmentService,
    private readonly security: LecBrowserSecurity,
  ) {}

  @Post()
  async issue(
    @AuthWorkspace() workspace: Workspace,
    @Headers('authorization') authorization: string,
    @Body() dto: DesktopHandoffDto,
  ) {
    if (!authorization?.startsWith('Bearer '))
      throw new UnauthorizedException('valid bearer token required');
    const accessToken = authorization.slice(7).trim();
    const principal = await this.coreProfile.principalFromAccessToken(
      accessToken,
      await this.oidc.identityFromAccessToken(accessToken),
    );
    await this.identities.resolve(workspace.id, principal);
    const issued = await this.handoffs.issue(
      workspace.id,
      principal,
      dto.accountGeneration,
      this.environment.getAppUrl(),
    );
    return { ...issued, issuer: principal.issuer, subject: principal.subject };
  }

  @Get('consume')
  async consume(
    @AuthWorkspace() workspace: Workspace,
    @Query('code') code: string,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const handoff = await this.handoffs.consume(
      code,
      workspace.id,
      this.environment.getAppUrl(),
    );
    const user = await this.identities.resolve(workspace.id, handoff);
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
    res
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .setCookie('authToken', token, { ...options, httpOnly: true })
      .setCookie('lecCsrf', this.security.issueCsrf(token), {
        ...options,
        httpOnly: false,
      });
    return res.redirect('/', 303);
  }
}
