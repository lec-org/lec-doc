import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { createServer, Server } from 'node:http';
import { MigrationService } from '../database/services/migration.service';
import { RedisHealthIndicator } from '../integrations/health/redis.health';

@Injectable()
export class WorkerHealthService implements OnApplicationShutdown {
  private server?: Server;

  constructor(
    private readonly migrations: MigrationService,
    private readonly redis: RedisHealthIndicator,
  ) {}

  async listen(port: number, host: string): Promise<void> {
    this.server = createServer(async (request, response) => {
      if (request.url === '/live') {
        response.writeHead(200).end('ok');
        return;
      }
      if (request.url !== '/ready') {
        response.writeHead(404).end();
        return;
      }
      try {
        await this.migrations.assertUpToDate();
        const redis = await this.redis.pingCheck('redis');
        if (redis.redis.status !== 'up') throw new Error('Redis unavailable');
        response.writeHead(200).end('ok');
      } catch {
        response.writeHead(503).end('not ready');
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, resolve);
    });
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
