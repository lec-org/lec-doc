import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isEmail } from 'class-validator';
import { Dispatcher, fetch } from 'undici';
import { z } from 'zod';
import { OutboundAgentFactory } from '../../integrations/outbound/outbound-agent.factory';
import { loadInternalCa } from '../../integrations/outbound/internal-ca';
import {
  LecOidcPrincipal,
  LecTenantPrincipal,
  LecTenantRole,
} from './lec-oidc.client';

const coreMeSchema = z.strictObject({
  data: z
    .strictObject({
      email: z.string().email(),
      nickname: z.string().min(1).max(255),
      real_name: z.string().trim().min(1).max(255),
      avatar_url: z.string().url().nullable().optional().or(z.literal('')),
    })
    .passthrough(),
});
const membershipsSchema = z.strictObject({
  data: z.array(
    z
      .strictObject({
        organization_id: z.uuid(),
        role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
        status: z.string(),
        organization: z
          .strictObject({ id: z.uuid(), status: z.string() })
          .passthrough(),
      })
      .passthrough(),
  ),
});

@Injectable()
export class LecCoreProfileClient {
  private readonly logger = new Logger(LecCoreProfileClient.name);
  private readonly caCert: string;

  constructor(
    private readonly config: ConfigService,
    private readonly agents: OutboundAgentFactory,
  ) {
    this.caCert = loadInternalCa(
      this.config.getOrThrow<string>('LEC_INTERNAL_CA_FILE'),
    );
  }

  async principalFromAccessToken(
    accessToken: string,
    principal: LecOidcPrincipal,
  ): Promise<LecTenantPrincipal> {
    try {
      const origin = new URL(this.config.getOrThrow<string>('LEC_CORE_URL'));
      if (
        origin.protocol !== 'https:' ||
        origin.pathname !== '/' ||
        origin.search ||
        origin.hash ||
        origin.username ||
        origin.password
      )
        throw new Error('Core origin invalid');
      const organizationId = this.config.getOrThrow<string>(
        'LEC_DOC_ORGANIZATION_ID',
      );
      z.uuid().parse(organizationId);
      const lease = await this.agents.lease(`${origin.origin}/api/v1/me`, {
        caCert: this.caCert,
      });
      try {
        const [profile, memberships] = await Promise.all([
          this.getJson(
            `${origin.origin}/api/v1/me`,
            accessToken,
            lease.dispatcher,
          ).then((body) => coreMeSchema.parse(body).data),
          this.getJson(
            `${origin.origin}/api/v1/me/organizations`,
            accessToken,
            lease.dispatcher,
          ).then((body) => membershipsSchema.parse(body).data),
        ]);
        const active = memberships.filter(
          (item) =>
            item.status === 'ACTIVE' && item.organization.status === 'ACTIVE',
        );
        if (
          active.length !== 1 ||
          active[0].organization_id !== organizationId ||
          active[0].organization.id !== organizationId
        ) {
          throw new UnauthorizedException(
            '账号必须且只能属于当前文档租户',
          );
        }
        const email = profile.email.toLowerCase();
        if (!isEmail(email) || email !== principal.email.toLowerCase()) {
          throw new Error('Core profile mismatch');
        }
        return {
          ...principal,
          email,
          name: profile.nickname,
          realName: profile.real_name,
          avatarUrl: profile.avatar_url || null,
          organizationId,
          tenantRole: active[0].role.toLowerCase() as LecTenantRole,
        };
      } finally {
        await lease.release();
      }
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      this.logger.warn(
        `Core profile unavailable: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      throw new ServiceUnavailableException('Lec Core 用户资料暂不可用', {
        cause: error,
      });
    }
  }

  private async getJson(
    url: string,
    accessToken: string,
    dispatcher: Dispatcher,
  ): Promise<unknown> {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${accessToken}` },
      dispatcher,
    });
    const contentType = response.headers.get('content-type')?.toLowerCase();
    if (!response.ok || !contentType?.startsWith('application/json')) {
      const status = response.status;
      await response.body?.cancel();
      throw new Error(`Core profile unavailable (${status})`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 256 * 1024) throw new Error('Core response too large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
}
