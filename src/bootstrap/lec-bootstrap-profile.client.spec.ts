import { MockAgent } from 'undici';
import { ConfigService } from '@nestjs/config';
import { LecBootstrapProfileClient } from './lec-bootstrap-profile.client';
import { OutboundAgentFactory } from '../integrations/outbound/outbound-agent.factory';

jest.mock('../integrations/outbound/internal-ca', () => ({
  loadInternalCa: () => 'test-ca',
}));

const issuer = 'https://id.example.test/oidc';
const organizationId = '20000000-0000-4000-8000-000000000001';
const subject = 'owner-subject';

describe('LecBootstrapProfileClient', () => {
  let agent: MockAgent;
  let client: LecBootstrapProfileClient;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    client = new LecBootstrapProfileClient(
      new ConfigService({
        LEC_CORE_URL: 'https://core.example.test',
        LEC_DOC_INTERNAL_TOKEN: 'd'.repeat(32),
        LEC_INTERNAL_CA_FILE: '/run/secrets/lec-internal-ca.pem',
      }),
      {
        lease: async () => ({
          dispatcher: agent,
          release: async () => undefined,
        }),
      } as unknown as OutboundAgentFactory,
    );
  });

  afterEach(async () => agent.close());

  it('returns only the matching authoritative Core real_name', async () => {
    agent
      .get('https://core.example.test')
      .intercept({
        path: '/api/v1/internal/doc-bootstrap/profile',
        method: 'POST',
        body: JSON.stringify({
          issuer,
          subject,
          organization_id: organizationId,
        }),
      })
      .reply(
        200,
        {
          data: {
            issuer,
            subject,
            organization_id: organizationId,
            real_name: 'Core 实名',
          },
        },
        { headers: { 'content-type': 'application/json' } },
      );

    await expect(
      client.getOwnerRealName({ issuer, subject, organizationId }),
    ).resolves.toBe('Core 实名');
  });

  it.each([
    [503, { error: { code: 'UNAVAILABLE' } }],
    [200, { data: { issuer, subject, organization_id: organizationId } }],
    [200, { data: { issuer, subject, organization_id: organizationId, real_name: 'Core 实名', leaked: true } }],
  ])('fails closed for status/schema mismatch', async (status, body) => {
    agent
      .get('https://core.example.test')
      .intercept({
        path: '/api/v1/internal/doc-bootstrap/profile',
        method: 'POST',
      })
      .reply(status, body, {
        headers: { 'content-type': 'application/json' },
      });
    await expect(
      client.getOwnerRealName({ issuer, subject, organizationId }),
    ).rejects.toThrow('Lec Core 启动实名资料暂不可用');
  });
});
