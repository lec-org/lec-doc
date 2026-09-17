import { ConfigService } from '@nestjs/config';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { EncryptionService } from '../../../integrations/encryption/encryption.service';
import {
  DESKTOP_HANDOFF_SECONDS,
  LecDesktopHandoffService,
} from '../lec-desktop-handoff.service';

const url = process.env.LEC_DOC_TEST_REDIS_URL;
(url ? describe : describe.skip)('真实 Redis Desktop handoff', () => {
  let redis: Redis;
  let handoffs: LecDesktopHandoffService;
  beforeAll(() => {
    redis = new Redis(url, { maxRetriesPerRequest: 1 });
    const encryption = new EncryptionService(
      new EnvironmentService(
        new ConfigService({
          APP_SECRET: 'test-only-handoff-encryption-secret-32-characters',
        }),
      ),
    );
    handoffs = new LecDesktopHandoffService(
      { getOrThrow: () => redis } as RedisService,
      encryption,
    );
  });
  afterAll(async () => redis.quit());

  it('并发消费只建立一个会话，且 Redis 只存 hash/encrypted payload 60 秒', async () => {
    const workspaceId = '10000000-0000-4000-8000-000000000001';
    const issued = await handoffs.issue(
      workspaceId,
      {
        issuer: 'https://id.example.test/realms/lec',
        subject: 'desktop-subject',
        email: 'desktop@example.test',
        name: 'Desktop User',
      },
      'account:9',
      'https://doc.example.test',
    );
    const key = `lec:desktop-handoff:${createHash('sha256').update(issued.code).digest('hex')}`;
    expect(key).not.toContain(issued.code);
    const encrypted = await redis.get(key);
    expect(encrypted).not.toContain('desktop-subject');
    expect(await redis.ttl(key)).toBeGreaterThan(0);
    expect(await redis.ttl(key)).toBeLessThanOrEqual(DESKTOP_HANDOFF_SECONDS);

    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        handoffs.consume(
          issued.code,
          workspaceId,
          'https://doc.example.test',
        ),
      ),
    );
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(7);
  });
});
