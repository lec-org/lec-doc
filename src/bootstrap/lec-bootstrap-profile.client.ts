import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetch } from 'undici';
import { z } from 'zod';
import { OutboundAgentFactory } from '../integrations/outbound/outbound-agent.factory';
import { loadInternalCa } from '../integrations/outbound/internal-ca';

const responseSchema = z.strictObject({
  data: z.strictObject({
    issuer: z.url(),
    subject: z.string().min(1).max(255),
    organization_id: z.uuid(),
    real_name: z.string().trim().min(1).max(100),
  }),
});

type BootstrapIdentity = {
  issuer: string;
  subject: string;
  organizationId: string;
};

@Injectable()
export class LecBootstrapProfileClient {
  private readonly caCert: string;

  constructor(
    private readonly config: ConfigService,
    private readonly agents: OutboundAgentFactory,
  ) {
    this.caCert = loadInternalCa(
      this.config.getOrThrow<string>('LEC_INTERNAL_CA_FILE'),
    );
  }

  async getOwnerRealName(identity: BootstrapIdentity): Promise<string> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5_000);
    let lease: Awaited<ReturnType<OutboundAgentFactory['lease']>> | undefined;
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
      const issuerUrl = new URL(identity.issuer);
      if (
        issuerUrl.protocol !== 'https:' ||
        issuerUrl.username ||
        issuerUrl.password ||
        issuerUrl.search ||
        issuerUrl.hash
      )
        throw new Error('OIDC issuer invalid');
      const issuer = issuerUrl.href;
      const organizationId = z.uuid().parse(identity.organizationId);
      const subject = z.string().trim().min(1).max(255).parse(identity.subject);
      const url = `${origin.origin}/api/v1/internal/doc-bootstrap/profile`;
      lease = await this.agents.lease(url, { caCert: this.caCert });
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: abort.signal,
        dispatcher: lease.dispatcher,
        headers: {
          authorization: `Bearer ${this.config.getOrThrow<string>('LEC_DOC_INTERNAL_TOKEN')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          issuer,
          subject,
          organization_id: organizationId,
        }),
      });
      if (
        response.status !== 200 ||
        !response.headers
          .get('content-type')
          ?.toLowerCase()
          .startsWith('application/json')
      ) {
        await response.body?.cancel();
        throw new Error('Core bootstrap profile unavailable');
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 64 * 1024) throw new Error('Core response too large');
        chunks.push(chunk);
      }
      const profile = responseSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      ).data;
      if (
        profile.issuer !== issuer ||
        profile.subject !== subject ||
        profile.organization_id !== organizationId
      )
        throw new Error('Core bootstrap profile mismatch');
      return profile.real_name;
    } catch (error) {
      throw new ServiceUnavailableException(
        'Lec Core 启动实名资料暂不可用',
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      abort.abort();
      await lease?.release();
    }
  }
}
