import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EncryptionService } from '../../integrations/encryption/encryption.service';
import { LecOidcTransaction } from './lec-oidc.client';

const randomValue = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const transactionSchema = z.object({
  state: randomValue,
  nonce: randomValue,
  verifier: randomValue,
});
export const OIDC_TRANSACTION_SECONDS = 300;

@Injectable()
export class LecOidcTransactions {
  constructor(
    private readonly redis: RedisService,
    private readonly encryption: EncryptionService,
  ) {}

  private key(workspaceId: string, binding: string, state: string): string {
    if (
      !randomValue.safeParse(binding).success ||
      !randomValue.safeParse(state).success
    ) {
      throw new UnauthorizedException('登录请求已失效，请重新登录');
    }
    return `lec:oidc:${createHash('sha256')
      .update(JSON.stringify([workspaceId, binding, state]))
      .digest('hex')}`;
  }

  async save(
    workspaceId: string,
    binding: string,
    transaction: LecOidcTransaction,
  ): Promise<void> {
    const value = transactionSchema.parse(transaction);
    const stored = await this.redis
      .getOrThrow()
      .set(
        this.key(workspaceId, binding, value.state),
        this.encryption.encrypt(JSON.stringify(value)),
        'EX',
        OIDC_TRANSACTION_SECONDS,
        'NX',
      );
    if (stored !== 'OK')
      throw new ServiceUnavailableException('无法创建登录请求');
  }

  async consume(
    workspaceId: string,
    binding: string,
    state: string,
  ): Promise<LecOidcTransaction> {
    // GETDEL 在所有实例之间原子消费；失败重试必须重新登录，不能恢复已消费事务。
    const encrypted = await this.redis
      .getOrThrow()
      .getdel(this.key(workspaceId, binding, state));
    if (!encrypted)
      throw new UnauthorizedException('登录请求已失效，请重新登录');
    try {
      const value = transactionSchema.parse(
        JSON.parse(this.encryption.decrypt(encrypted)),
      );
      if (value.state !== state) throw new Error('state mismatch');
      return value;
    } catch {
      throw new UnauthorizedException('登录请求已失效，请重新登录');
    }
  }
}
