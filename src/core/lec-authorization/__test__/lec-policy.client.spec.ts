import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MockAgent } from 'undici';
import { z } from 'zod';
import { OutboundAgentFactory } from '../../../integrations/outbound/outbound-agent.factory';
import { LecPolicyClient } from '../lec-policy.client';

jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  readFileSync: jest.fn(
    () =>
      jest.requireActual<typeof import('node:tls')>('node:tls')
        .rootCertificates[0],
  ),
}));

const workspace = '01995ad0-1111-7111-8111-111111111111';
const organization = '01995ad0-2222-7111-8111-111111111111';
const page = '01995ad0-3333-7111-8111-111111111111';
const principal = {
  type: 'OIDC' as const,
  issuer: 'https://sso.example.test/oidc',
  subject: 'member',
};
const item = {
  resource_kind: 'DOCMOST_PAGE' as const,
  resource_id: page,
  capability: 'VIEW' as const,
};

describe('Core 在线 PDP 契约', () => {
  let agent: MockAgent;
  let client: LecPolicyClient;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    client = new LecPolicyClient(
      new ConfigService({
        LEC_CORE_URL: 'https://core.example.test',
        LEC_DOC_INTERNAL_TOKEN: 'd'.repeat(32),
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
  function reply(change: (data: any) => void = () => {}, status = 200) {
    agent
      .get('https://core.example.test')
      .intercept({
        path: '/api/v1/internal/doc-authorize-batch',
        method: 'POST',
        headers: { authorization: `Bearer ${'d'.repeat(32)}` },
      })
      .reply(
        status,
        (options) => {
          const request = JSON.parse(String(options.body));
          const data = {
            request_id: request.request_id,
            items: request.items.map((entry: any) => ({
              ...entry,
              workspace_id: workspace,
              organization_id: organization,
              resource_version: 2,
              allowed: true,
              reason_code: 'ALLOW',
            })),
          };
          change(data);
          return JSON.stringify({ data });
        },
        { headers: { 'content-type': 'application/json' } },
      );
  }
  it('每次调用在线查询；一次请求去重后按原始项目还原', async () => {
    reply();
    reply((data) => {
      data.items[0].allowed = false;
      data.items[0].reason_code = 'NOT_ALLOWED';
    });
    expect(
      (await client.authorize(workspace, principal, [item, item])).map(
        (x) => x.allowed,
      ),
    ).toEqual([true, true]);
    expect(
      (await client.authorize(workspace, principal, [item]))[0].allowed,
    ).toBe(false);
    agent.assertNoPendingInterceptors();
  });
  it.each([
    [
      '缺项',
      (d: any) => {
        d.items = [];
      },
    ],
    [
      '重复',
      (d: any) => {
        d.items.push(d.items[0]);
      },
    ],
    [
      '额外',
      (d: any) => {
        d.items.push({ ...d.items[0], item_id: 'other' });
      },
    ],
    [
      '主体请求串线',
      (d: any) => {
        d.request_id = 'wrong';
      },
    ],
    [
      '租户串线',
      (d: any) => {
        d.items[0].workspace_id = organization;
      },
    ],
    [
      '资源串线',
      (d: any) => {
        d.items[0].resource_id = organization;
      },
    ],
    [
      '能力串线',
      (d: any) => {
        d.items[0].capability = 'EDIT';
      },
    ],
    [
      '零版本 allow',
      (d: any) => {
        d.items[0].resource_version = 0;
      },
    ],
    [
      '缺少组织',
      (d: any) => {
        d.items[0].organization_id = null;
      },
    ],
    [
      '伪造允许',
      (d: any) => {
        d.items[0].allowed = 'true';
      },
    ],
    [
      '原因矛盾',
      (d: any) => {
        d.items[0].reason_code = 'NOT_ALLOWED';
      },
    ],
  ])('%s 整批 fail closed', async (_, change) => {
    reply(change);
    await expect(
      client.authorize(workspace, principal, [item]),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it.each([401, 403, 429, 500, 503, 302])(
    'Core HTTP %i 不转成 allow',
    async (status) => {
      reply(undefined, status);
      await expect(
        client.authorize(workspace, principal, [item]),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    },
  );
  it('超时连接失败不使用旧 allow', async () => {
    reply();
    await client.authorize(workspace, principal, [item]);
    await expect(
      client.authorize(workspace, principal, [item]),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it.each([
    [400, BadRequestException, 'DOC_INVALID_REQUEST'],
    [403, ForbiddenException, 'DOC_FORBIDDEN'],
    [409, ConflictException, 'DOC_VERSION_CONFLICT'],
  ] as const)(
    '生命周期命令保留经验证的 Core HTTP %i 语义',
    async (status, ErrorType, code) => {
      agent
        .get('https://core.example.test')
        .intercept({
          path: '/api/v1/internal/doc-resources/reserve',
          method: 'POST',
        })
        .reply(
          status,
          JSON.stringify({ error: { code, message: 'upstream detail' } }),
          { headers: { 'content-type': 'application/json' } },
        );
      const promise = client.send('doc-resources/reserve', {}, z.unknown());
      await expect(promise).rejects.toBeInstanceOf(ErrorType);
      await expect(promise).rejects.not.toThrow('upstream detail');
    },
  );

  it('真实总截止时间覆盖迟到的 DNS lease，并在其最终返回后释放', async () => {
    let released!: () => void;
    const releasedPromise = new Promise<void>(
      (resolve) => (released = resolve),
    );
    const release = jest.fn(async () => released());
    client = new LecPolicyClient(
      new ConfigService({
        LEC_CORE_URL: 'https://core.example.test',
        LEC_DOC_INTERNAL_TOKEN: 'd'.repeat(32),
        LEC_INTERNAL_CA_FILE: '/run/secrets/lec-internal-ca.pem',
      }),
      {
        lease: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ dispatcher: agent, release }), 3250),
          ),
      } as unknown as OutboundAgentFactory,
    );

    const started = Date.now();
    await expect(
      client.send('doc-resources/reserve', {}, z.unknown()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(3250);
    expect(release).not.toHaveBeenCalled();
    await releasedPromise;
    expect(release).toHaveBeenCalledTimes(1);
  }, 5000);
});
