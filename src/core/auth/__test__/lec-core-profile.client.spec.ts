import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { MockAgent } from 'undici';
import { LecCoreProfileClient } from '../lec-core-profile.client';

jest.mock('../../../integrations/outbound/internal-ca', () => ({
  loadInternalCa: () => 'test-ca',
}));

const organizationId = '10000000-0000-4000-8000-000000000001';
const otherOrganizationId = '10000000-0000-4000-8000-000000000002';
const principal = {
  issuer: 'https://id.example.test/oidc',
  subject: 'subject',
  email: 'user@example.test',
  name: 'Token Name',
};

describe('Lec Core profile synchronization', () => {
  let agent: MockAgent;
  let client: LecCoreProfileClient;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    client = new LecCoreProfileClient(
      {
        getOrThrow: (key: string) => {
          if (key === 'LEC_CORE_URL') return 'https://core.example.test';
          if (key === 'LEC_DOC_ORGANIZATION_ID') return organizationId;
          if (key === 'LEC_INTERNAL_CA_FILE') return '/ca.pem';
          throw new Error(`unexpected config key: ${key}`);
        },
      } as any,
      {
        lease: async () => ({
          dispatcher: agent,
          release: async () => undefined,
        }),
      } as any,
    );
  });

  afterEach(async () => {
    await agent.close();
  });

  function mockProfile(statusCode = 200) {
    agent
      .get('https://core.example.test')
      .intercept({ path: '/api/v1/me', method: 'GET' })
      .reply(
        statusCode,
        statusCode === 200
          ? {
              data: {
                id: 'core-user',
                nickname: 'Core User',
                real_name: '真实用户',
                email: 'USER@example.test',
                avatar_url: 'https://cdn.example.test/avatar.png',
              },
            }
          : { error: { code: 'UNAVAILABLE' } },
        { headers: { 'content-type': 'application/json' } },
      );
  }

  function mockMemberships(
    memberships: Array<{
      organization_id: string;
      role: 'OWNER' | 'ADMIN' | 'MEMBER';
      status: string;
      organization: { id: string; status: string };
    }>,
  ) {
    agent
      .get('https://core.example.test')
      .intercept({ path: '/api/v1/me/organizations', method: 'GET' })
      .reply(200, { data: memberships }, {
        headers: { 'content-type': 'application/json' },
      });
  }

  function membership(
    role: 'OWNER' | 'ADMIN' | 'MEMBER',
    id = organizationId,
  ) {
    return {
      organization_id: id,
      role,
      status: 'ACTIVE',
      organization: { id, status: 'ACTIVE' },
    };
  }

  it.each([
    ['OWNER', 'owner'],
    ['ADMIN', 'admin'],
    ['MEMBER', 'member'],
  ] as const)('maps Core %s to Doc %s', async (coreRole, docRole) => {
    mockProfile();
    mockMemberships([membership(coreRole)]);

    await expect(
      client.principalFromAccessToken('token', principal),
    ).resolves.toEqual({
      ...principal,
      email: 'user@example.test',
      name: 'Core User',
      realName: '真实用户',
      avatarUrl: 'https://cdn.example.test/avatar.png',
      organizationId,
      tenantRole: docRole,
    });
  });

  it('rejects a user without one active membership', async () => {
    mockProfile();
    mockMemberships([
      {
        ...membership('MEMBER'),
        status: 'LEFT',
      },
    ]);

    await expect(
      client.principalFromAccessToken('token', principal),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an active membership in another organization', async () => {
    mockProfile();
    mockMemberships([membership('MEMBER', otherOrganizationId)]);

    await expect(
      client.principalFromAccessToken('token', principal),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects two active organization memberships', async () => {
    mockProfile();
    mockMemberships([
      membership('OWNER'),
      membership('MEMBER', otherOrganizationId),
    ]);

    await expect(
      client.principalFromAccessToken('token', principal),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('fails closed when Core is unavailable', async () => {
    mockProfile(503);
    mockMemberships([membership('OWNER')]);

    await expect(
      client.principalFromAccessToken('token', principal),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
