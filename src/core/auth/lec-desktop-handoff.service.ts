import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { EncryptionService } from '../../integrations/encryption/encryption.service';
import { LecOidcPrincipal } from './lec-oidc.client';

const accountGeneration = z.string().min(1).max(128);
const handoffSchema = z.strictObject({
  workspaceId: z.uuid(),
  issuer: z.url(),
  subject: z.string().min(1).max(255),
  email: z.email(),
  name: z.string().min(1).max(255),
  accountGeneration,
  origin: z.url(),
});
export const DESKTOP_HANDOFF_SECONDS = 60;

@Injectable()
export class LecDesktopHandoffService {
  constructor(
    private readonly redis: RedisService,
    private readonly encryption: EncryptionService,
  ) {}

  async issue(
    workspaceId: string,
    principal: LecOidcPrincipal,
    generation: string,
    origin: string,
  ) {
    const code = randomBytes(32).toString('base64url');
    const value = handoffSchema.parse({
      workspaceId,
      ...principal,
      accountGeneration: accountGeneration.parse(generation),
      origin: new URL(origin).origin,
    });
    const stored = await this.redis
      .getOrThrow()
      .set(
        this.key(code),
        this.encryption.encrypt(JSON.stringify(value)),
        'EX',
        DESKTOP_HANDOFF_SECONDS,
        'NX',
      );
    if (stored !== 'OK')
      throw new ServiceUnavailableException('无法创建桌面登录请求');
    return { code, expiresInSeconds: DESKTOP_HANDOFF_SECONDS };
  }

  async consume(code: string, workspaceId: string, origin: string) {
    const encrypted = await this.redis.getOrThrow().getdel(this.key(code));
    if (!encrypted) throw this.invalid();
    try {
      const value = handoffSchema.parse(
        JSON.parse(this.encryption.decrypt(encrypted)),
      );
      if (
        value.workspaceId !== workspaceId ||
        value.origin !== new URL(origin).origin
      )
        throw new Error('binding mismatch');
      return value;
    } catch {
      throw this.invalid();
    }
  }

  private key(code: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw this.invalid();
    return `lec:desktop-handoff:${createHash('sha256').update(code).digest('hex')}`;
  }

  private invalid() {
    return new UnauthorizedException('桌面登录请求已失效，请重试');
  }
}
