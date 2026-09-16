import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis, { RedisOptions } from 'ioredis';
import { INestApplicationContext } from '@nestjs/common';
import { LecBrowserSecurity } from '../../core/auth/lec-browser-security';
import {
  createRetryStrategy,
  parseRedisUrl,
  RedisConfig,
} from '../../common/helpers';

export class WsRedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>;
  private redisConfig: RedisConfig;

  constructor(
    app: INestApplicationContext,
    private readonly browserSecurity: LecBrowserSecurity,
  ) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    this.redisConfig = parseRedisUrl(process.env.REDIS_URL);

    const options: RedisOptions = {
      family: this.redisConfig.family,
      tls: this.redisConfig.tls,
      retryStrategy: createRetryStrategy(),
    };

    const pubClient = new Redis(process.env.REDIS_URL, options);
    const subClient = new Redis(process.env.REDIS_URL, options);

    pubClient.on('error', (err) => () => {});
    subClient.on('error', (err) => () => {});

    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, {
      ...options,
      allowRequest: (request, callback) => {
        try {
          this.browserSecurity.assertOrigin(request.headers.origin, true);
          callback(null, true);
        } catch {
          callback('Forbidden origin', false);
        }
      },
    });
    server.adapter(this.adapterConstructor);
    return server;
  }
}
