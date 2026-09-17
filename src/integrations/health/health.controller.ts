import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { PostgresHealthIndicator } from './postgres.health';
import { RedisHealthIndicator } from './redis.health';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { MigrationService } from '../../database/services/migration.service';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private postgres: PostgresHealthIndicator,
    private redis: RedisHealthIndicator,
    private migrations: MigrationService,
  ) {}

  @SkipTransform()
  @Get()
  @HealthCheck()
  async check() {
    return this.health.check([
      () => this.postgres.pingCheck('database'),
      () => this.redis.pingCheck('redis'),
    ]);
  }

  @SkipTransform()
  @Get('ready')
  @HealthCheck()
  async checkReady() {
    return this.health.check([
      () => this.postgres.pingCheck('database'),
      () => this.redis.pingCheck('redis'),
      async () => {
        await this.migrations.assertUpToDate();
        return { schema: { status: 'up' as const } };
      },
    ]);
  }

  @Get('live')
  async checkLive() {
    return 'ok';
  }
}
