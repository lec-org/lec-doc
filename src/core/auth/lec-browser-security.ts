import { ForbiddenException, Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { EnvironmentService } from '../../integrations/environment/environment.service';

@Injectable()
export class LecBrowserSecurity {
  constructor(private readonly environment: EnvironmentService) {}

  /** HTTP、Socket.IO 和 Hocuspocus 使用同一个精确 Origin 规则。 */
  assertOrigin(origin: unknown, required = false): void {
    if (
      (!origin && required) ||
      (origin !== undefined && origin !== this.environment.getAppUrl())
    ) {
      throw new ForbiddenException('请求来源不受信任');
    }
  }

  private signature(session: string, nonce: string): string {
    return createHmac('sha256', this.environment.getAppSecret())
      .update(JSON.stringify(['lec:csrf:v1', session, nonce]))
      .digest('base64url');
  }

  issueCsrf(session: string): string {
    const nonce = randomBytes(32).toString('base64url');
    return `${nonce}.${this.signature(session, nonce)}`;
  }

  private assertCsrf(
    session: string,
    cookie: string | undefined,
    header: unknown,
  ): void {
    if (
      typeof header !== 'string' ||
      cookie !== header ||
      !/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(header)
    ) {
      throw new ForbiddenException('请求校验已失效，请刷新页面');
    }
    const [nonce, signature] = header.split('.');
    if (
      !timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(this.signature(session, nonce)),
      )
    ) {
      throw new ForbiddenException('请求校验已失效，请刷新页面');
    }
  }

  install(app: FastifyInstance): void {
    // 在 Cookie 解析前拒绝跨 Origin；安全方法允许普通浏览器导航不携带 Origin。
    app.addHook('onRequest', async (request, reply) => {
      try {
        const internalRevocation =
          request.method === 'POST' &&
          request.url.split('?', 1)[0] === '/api/internal/core/revocations';
        this.assertOrigin(
          request.headers.origin,
          !internalRevocation &&
            !['GET', 'HEAD', 'OPTIONS'].includes(request.method),
        );
      } catch {
        return reply.code(403).send({ message: '请求来源不受信任' });
      }
    });
    app.addHook('preValidation', async (request, reply) => {
      if (
        ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ||
        !request.cookies?.authToken
      )
        return;
      try {
        this.assertCsrf(
          request.cookies.authToken,
          request.cookies.lecCsrf,
          request.headers['x-lec-csrf'],
        );
      } catch {
        return reply.code(403).send({ message: '请求校验已失效，请刷新页面' });
      }
    });
  }
}
