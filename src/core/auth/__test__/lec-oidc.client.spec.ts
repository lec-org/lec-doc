import { ConfigService } from '@nestjs/config';
import { MockAgent } from 'undici';
import { generateKeyPairSync, sign } from 'node:crypto';
import { OutboundAgentFactory } from '../../../integrations/outbound/outbound-agent.factory';
import { LecOidcClient } from '../lec-oidc.client';

jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  readFileSync: jest.fn(
    () =>
      jest.requireActual<typeof import('node:tls')>('node:tls')
        .rootCertificates[0],
  ),
}));

const issuer = 'https://sso.example.test/realms/lec';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...keys.publicKey.export({ format: 'jwk' }),
  kid: 'test-key',
  use: 'sig',
  alg: 'RS256',
};
function signedToken(claims: Record<string, unknown>): string {
  const payload = [{ alg: 'RS256', kid: 'test-key' }, claims]
    .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
    .join('.');
  return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), keys.privateKey).toString('base64url')}`;
}
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/auth`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/certs`,
  userinfo_endpoint: `${issuer}/userinfo`,
  response_types_supported: ['code'],
  subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['RS256'],
  code_challenge_methods_supported: ['S256'],
};

describe('LecSSO OIDC 浏览器协议', () => {
  let agent: MockAgent;
  let client: LecOidcClient;
  let discoveryMetadata: typeof metadata;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    discoveryMetadata = { ...metadata };
    agent
      .get('https://sso.example.test')
      .intercept({ path: '/realms/lec/.well-known/openid-configuration' })
      .reply(200, () => JSON.stringify(discoveryMetadata), {
        headers: { 'content-type': 'application/json' },
      })
      .persist();
    const factory = {
      lease: async () => ({ dispatcher: agent, release: async () => {} }),
    };
    client = new LecOidcClient(
      new ConfigService({
        LEC_DOC_OIDC_ISSUER: issuer,
        LEC_DOC_CLIENT_SECRET: 'test-client-secret',
        APP_URL: 'https://doc.example.test',
        LEC_INTERNAL_CA_FILE: '/run/secrets/lec-internal-ca.pem',
      }),
      factory as unknown as OutboundAgentFactory,
    );
  });

  afterEach(async () => {
    await agent.close();
  });

  it('使用精确回调和每次独立的 S256、state、nonce 发起登录', async () => {
    const result = await client.begin();
    const url = new URL(result.url);
    expect(url.origin + url.pathname).toBe(metadata.authorization_endpoint);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://doc.example.test/api/auth/oidc/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(result.transaction.state);
    expect(url.searchParams.get('nonce')).toBe(result.transaction.nonce);
    expect(result.transaction.verifier.length).toBeGreaterThanOrEqual(43);
    expect(result.url).not.toContain(result.transaction.verifier);
    expect(result.url).not.toContain('test-client-secret');
  });

  it('Desktop access token 仅经同源 userinfo 换取稳定主体', async () => {
    agent
      .get('https://sso.example.test')
      .intercept({
        path: '/realms/lec/userinfo',
        headers: { authorization: 'Bearer desktop-access-token' },
      })
      .reply(200, {
        sub: 'desktop-subject',
        email: 'desktop@example.test',
        email_verified: true,
        name: 'Desktop User',
      });
    await expect(
      client.identityFromAccessToken('desktop-access-token'),
    ).resolves.toEqual({
      issuer,
      subject: 'desktop-subject',
      email: 'desktop@example.test',
      name: 'Desktop User',
    });
  });

  it('回调通过签名和 claims 校验后返回稳定主体，不返回 access token', async () => {
    const { transaction } = await client.begin();
    const now = Math.floor(Date.now() / 1000);
    const pool = agent.get('https://sso.example.test');
    pool.intercept({ path: '/realms/lec/token', method: 'POST' }).reply(
      200,
      {
        access_token: 'private-access-token',
        token_type: 'Bearer',
        id_token: signedToken({
          iss: issuer,
          sub: 'subject-1',
          aud: 'lec-doc',
          exp: now + 300,
          iat: now,
          nonce: transaction.nonce,
          email: 'user@example.test',
          email_verified: true,
          name: '测试用户',
        }),
      },
      { headers: { 'content-type': 'application/json' } },
    );
    pool
      .intercept({ path: '/realms/lec/certs' })
      .reply(
        200,
        { keys: [jwk] },
        { headers: { 'content-type': 'application/json' } },
      );
    const principal = await client.complete(
      new URL(
        `https://doc.example.test/api/auth/oidc/callback?code=test-code&state=${transaction.state}`,
      ),
      transaction,
    );
    expect(principal).toEqual({
      issuer,
      subject: 'subject-1',
      email: 'user@example.test',
      name: '测试用户',
    });
  });

  it('discovery 不能把浏览器导向另一个 origin 的授权端点', async () => {
    discoveryMetadata.authorization_endpoint =
      'https://attacker.example.test/auth';
    await expect(client.begin()).rejects.toThrow();
  });

  it.each([
    ['issuer', { iss: 'https://evil.example.test' }],
    ['subject', { sub: '' }],
    ['audience', { aud: 'another-client' }],
    ['azp', { azp: 'another-client' }],
    ['expiry', { exp: 1 }],
    ['future iat', { iat: 9999999999 }],
    ['missing iat', { iat: undefined }],
    ['nonce', { nonce: 'wrong-nonce' }],
    ['email_verified', { email_verified: false }],
    ['invalid email', { email: 'not-an-email' }],
  ])('拒绝已签名但 %s 不符的 ID token', async (_name, overrides) => {
    const { transaction } = await client.begin();
    const now = Math.floor(Date.now() / 1000);
    const pool = agent.get('https://sso.example.test');
    pool.intercept({ path: '/realms/lec/token', method: 'POST' }).reply(
      200,
      {
        access_token: 'private-access-token',
        token_type: 'Bearer',
        id_token: signedToken({
          iss: issuer,
          sub: 'subject-1',
          aud: 'lec-doc',
          exp: now + 300,
          iat: now,
          nonce: transaction.nonce,
          email: 'user@example.test',
          email_verified: true,
          ...overrides,
        }),
      },
      { headers: { 'content-type': 'application/json' } },
    );
    pool
      .intercept({ path: '/realms/lec/certs' })
      .reply(
        200,
        { keys: [jwk] },
        { headers: { 'content-type': 'application/json' } },
      );
    await expect(
      client.complete(
        new URL(
          `https://doc.example.test/api/auth/oidc/callback?code=test-code&state=${transaction.state}`,
        ),
        transaction,
      ),
    ).rejects.toThrow();
  });

  it('TLS token 响应仍必须验证 JWT 签名', async () => {
    const { transaction } = await client.begin();
    const now = Math.floor(Date.now() / 1000);
    const valid = signedToken({
      iss: issuer,
      sub: 'subject-1',
      aud: 'lec-doc',
      exp: now + 300,
      iat: now,
      nonce: transaction.nonce,
      email: 'user@example.test',
      email_verified: true,
    });
    const parts = valid.split('.');
    parts[1] = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(parts[1], 'base64url').toString()),
        sub: 'attacker',
      }),
    ).toString('base64url');
    const pool = agent.get('https://sso.example.test');
    pool.intercept({ path: '/realms/lec/token', method: 'POST' }).reply(
      200,
      {
        access_token: 'private-access-token',
        token_type: 'Bearer',
        id_token: parts.join('.'),
      },
      { headers: { 'content-type': 'application/json' } },
    );
    pool
      .intercept({ path: '/realms/lec/certs' })
      .reply(
        200,
        { keys: [jwk] },
        { headers: { 'content-type': 'application/json' } },
      );
    await expect(
      client.complete(
        new URL(
          `https://doc.example.test/api/auth/oidc/callback?code=test-code&state=${transaction.state}`,
        ),
        transaction,
      ),
    ).rejects.toThrow();
  });

  it.each([
    'https://other.example.test/api/auth/oidc/callback',
    'https://doc.example.test/wrong',
  ])('不接受客户端提供的回调 %s', async (url) => {
    const { transaction } = await client.begin();
    await expect(client.complete(new URL(url), transaction)).rejects.toThrow(
      '回调地址不匹配',
    );
  });

  it('错误 state 在换取 token 前拒绝', async () => {
    const { transaction } = await client.begin();
    // 没有注册 token endpoint mock；若发起换取请求，失败原因将不同。
    await expect(
      client.complete(
        new URL(
          'https://doc.example.test/api/auth/oidc/callback?code=test-code&state=wrong',
        ),
        transaction,
      ),
    ).rejects.toMatchObject({ code: 'OAUTH_INVALID_RESPONSE' });
  });
});
