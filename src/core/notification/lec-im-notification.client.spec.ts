import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MockAgent } from 'undici';
import { OutboundAgentFactory } from '../../integrations/outbound/outbound-agent.factory';
import { LecImNotificationClient } from './lec-im-notification.client';

jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  readFileSync: jest.fn(
    () =>
      jest.requireActual<typeof import('node:tls')>('node:tls')
        .rootCertificates[0],
  ),
}));

const command = {
  event_id: '10000000-0000-4000-8000-000000000001',
  workspace_id: '20000000-0000-4000-8000-000000000001',
  resource_id: '30000000-0000-4000-8000-000000000001',
  recipient: { issuer: 'https://id.example.test', subject: 'recipient' },
  event_type: 'PAGE_LIKED',
  text: '有人点赞了你的云文档',
};

describe('LecImNotificationClient', () => {
  let agent: MockAgent;
  let client: LecImNotificationClient;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    client = new LecImNotificationClient(
      new ConfigService({
        LEC_IM_NOTIFICATION_URL:
          'https://im.example.test/internal/v1/document-notifications',
        LEC_DOC_NOTIFICATION_TOKEN: 'n'.repeat(32),
        LEC_INTERNAL_CA_FILE: '/run/secrets/lec-internal-ca.pem',
      }),
      {
        lease: async () => ({ dispatcher: agent, release: async () => {} }),
      } as unknown as OutboundAgentFactory,
    );
  });

  afterEach(async () => {
    await agent.close();
  });

  it('accepts only the matching immutable event id', async () => {
    agent
      .get('https://im.example.test')
      .intercept({
        path: '/internal/v1/document-notifications',
        method: 'POST',
        headers: { authorization: `Bearer ${'n'.repeat(32)}` },
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            event_id: '10000000-0000-4000-8000-000000000099',
            status: 'ACCEPTED',
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );

    await expect(client.send(command)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it.each([
    [503, 'application/json', JSON.stringify({ error: { code: 'DOWN' } })],
    [200, 'text/html', '<html>proxy error</html>'],
    [200, 'application/json', '{not-json'],
  ])(
    'fails closed for status/content/body mismatch',
    async (status, contentType, body) => {
      agent
        .get('https://im.example.test')
        .intercept({
          path: '/internal/v1/document-notifications',
          method: 'POST',
        })
        .reply(status, body, { headers: { 'content-type': contentType } });

      await expect(client.send(command)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    },
  );

  it('enforces the total deadline while acquiring the pinned dispatcher', async () => {
    let releaseLease!: () => void;
    const leaseReady = new Promise<void>((resolve) => (releaseLease = resolve));
    client = new LecImNotificationClient(
      new ConfigService({
        LEC_IM_NOTIFICATION_URL:
          'https://im.example.test/internal/v1/document-notifications',
        LEC_DOC_NOTIFICATION_TOKEN: 'n'.repeat(32),
        LEC_INTERNAL_CA_FILE: '/run/secrets/lec-internal-ca.pem',
      }),
      {
        lease: async () => {
          await leaseReady;
          return { dispatcher: agent, release: async () => {} };
        },
      } as unknown as OutboundAgentFactory,
    );

    const started = Date.now();
    await expect(client.send(command)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
    releaseLease();
  }, 5000);
});
