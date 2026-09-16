import { ConfigService } from '@nestjs/config';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import Redis from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { EncryptionService } from '../../../integrations/encryption/encryption.service';
import { LecOidcTransactions } from '../lec-oidc-transactions';

const url = process.env.LEC_DOC_TEST_REDIS_URL;
(url ? describe : describe.skip)('真实 Redis 一次性 OIDC 事务', () => {
  let redis: Redis;
  let transactions: LecOidcTransactions;
  beforeAll(() => {
    redis = new Redis(url, { maxRetriesPerRequest: 1 });
    const encryption = new EncryptionService(
      new EnvironmentService(
        new ConfigService({
          APP_SECRET: 'test-only-oidc-encryption-secret-32-characters',
        }),
      ),
    );
    transactions = new LecOidcTransactions(
      { getOrThrow: () => redis } as RedisService,
      encryption,
    );
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('并发 callback 只有一个能消费，后续 replay 拒绝', async () => {
    const transaction = {
      state: randomBytes(32).toString('base64url'),
      nonce: randomBytes(32).toString('base64url'),
      verifier: randomBytes(32).toString('base64url'),
    };
    const binding = randomBytes(32).toString('base64url');
    await transactions.save('workspace-1', binding, transaction);
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        transactions.consume('workspace-1', binding, transaction.state),
      ),
    );
    expect(
      attempts.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      attempts.filter((result) => result.status === 'rejected'),
    ).toHaveLength(7);
    await expect(
      transactions.consume('workspace-1', binding, transaction.state),
    ).rejects.toThrow();
  });

  it('另一个浏览器或 workspace 不能消费事务，也不能破坏原浏览器的登录', async () => {
    const transaction = {
      state: randomBytes(32).toString('base64url'),
      nonce: randomBytes(32).toString('base64url'),
      verifier: randomBytes(32).toString('base64url'),
    };
    const binding = randomBytes(32).toString('base64url');
    await transactions.save('workspace-1', binding, transaction);
    await expect(
      transactions.consume('workspace-2', binding, transaction.state),
    ).rejects.toThrow();
    await expect(
      transactions.consume(
        'workspace-1',
        randomBytes(32).toString('base64url'),
        transaction.state,
      ),
    ).rejects.toThrow();
    await expect(
      transactions.consume('workspace-1', binding, transaction.state),
    ).resolves.toEqual(transaction);
  });
  it('PKCE verifier 加密存储且事务最多存活五分钟，过期后不能消费', async () => {
    const transaction = {
      state: randomBytes(32).toString('base64url'),
      nonce: randomBytes(32).toString('base64url'),
      verifier: randomBytes(32).toString('base64url'),
    };
    const binding = randomBytes(32).toString('base64url');
    const key = `lec:oidc:${createHash('sha256')
      .update(JSON.stringify(['workspace-1', binding, transaction.state]))
      .digest('hex')}`;
    await transactions.save('workspace-1', binding, transaction);
    try {
      const encrypted = await redis.get(key);
      expect(encrypted).not.toContain(transaction.verifier);
      expect(encrypted).not.toContain(transaction.nonce);
      expect(await redis.ttl(key)).toBeGreaterThan(0);
      expect(await redis.ttl(key)).toBeLessThanOrEqual(300);
      await redis.pexpire(key, 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(
        transactions.consume('workspace-1', binding, transaction.state),
      ).rejects.toThrow();
    } finally {
      await redis.del(key);
    }
  });
});
