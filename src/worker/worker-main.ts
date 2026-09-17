import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { InternalLogFilter } from '../common/logger/internal-log-filter';
import { WorkerModule } from './worker.module';
import { WorkerHealthService } from './worker-health.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: new InternalLogFilter(),
    bufferLogs: false,
  });
  app.useLogger(app.get(PinoLogger));
  app.enableShutdownHooks();
  await app
    .get(WorkerHealthService)
    .listen(Number(process.env.WORKER_HEALTH_PORT || 3002), '0.0.0.0');

  const logger = new Logger('Worker');
  process.on('unhandledRejection', (reason, promise) => {
    logger.error(`UnhandledRejection, reason: ${reason}`, promise);
  });
  process.on('uncaughtException', (error) => {
    logger.error('UncaughtException:', error);
  });
  logger.log('Worker started');
}

void bootstrap();
