import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { RedisModule } from '@nestjs-labs/nestjs-ioredis';
import { ScheduleModule } from '@nestjs/schedule';
import { ClsModule } from 'nestjs-cls';
import { CollabHistoryModule } from '../collaboration/collab-history.module';
import { HistoryProcessor } from '../collaboration/processors/history.processor';
import { LoggerModule } from '../common/logger/logger.module';
import { AttachmentModule } from '../core/attachment/attachment.module';
import { AttachmentProcessor } from '../core/attachment/processors/attachment.processor';
import { CaslModule } from '../core/casl/casl.module';
import { LecAuthorizationModule } from '../core/lec-authorization/lec-authorization.module';
import { NotificationModule } from '../core/notification/notification.module';
import { NotificationBackgroundModule } from '../core/notification/notification-background.module';
import { LecPageControlModule } from '../core/lec-authorization/lec-page-control.module';
import { SessionCleanupModule } from '../core/session/session-cleanup.module';
import { TrashCleanupModule } from '../core/page/trash-cleanup.module';
import { PageAccessModule } from '../core/page/page-access/page-access.module';
import { RevocationModule } from '../collaboration/revocation.module';
import { NotificationProcessor } from '../core/notification/notification.processor';
import { WatcherModule } from '../core/watcher/watcher.module';
import { DatabaseModule } from '../database/database.module';
import { NoopAuditModule } from '../integrations/audit/audit.module';
import { EnvironmentModule } from '../integrations/environment/environment.module';
import { ImportModule } from '../integrations/import/import.module';
import { FileTaskProcessor } from '../integrations/import/processors/file-task.processor';
import { MailModule } from '../integrations/mail/mail.module';
import { EmailProcessor } from '../integrations/mail/processors/email.processor';
import { OutboundModule } from '../integrations/outbound/outbound.module';
import { GeneralQueueProcessor } from '../integrations/queue/processors/general-queue.processor';
import { QueueModule } from '../integrations/queue/queue.module';
import { RedisConfigService } from '../integrations/redis/redis-config.service';
import { StorageModule } from '../integrations/storage/storage.module';
import { HealthModule } from '../integrations/health/health.module';
import { WorkerHealthService } from './worker-health.service';

export const WORKER_PROCESSORS = [
  GeneralQueueProcessor,
  EmailProcessor,
  FileTaskProcessor,
  AttachmentProcessor,
  HistoryProcessor,
  NotificationProcessor,
];

@Module({
  imports: [
    ClsModule.forRoot({ global: true }),
    LoggerModule,
    EnvironmentModule,
    EventEmitterModule.forRoot(),
    NoopAuditModule,
    OutboundModule,
    CaslModule,
    DatabaseModule,
    RedisModule.forRootAsync({ useClass: RedisConfigService }),
    HealthModule,
    QueueModule,
    StorageModule.forRootAsync({ imports: [EnvironmentModule] }),
    MailModule.forRootAsync({ imports: [EnvironmentModule] }),
    AttachmentModule,
    ImportModule,
    PageAccessModule,
    NotificationModule,
    NotificationBackgroundModule,
    CollabHistoryModule,
    WatcherModule,
    LecAuthorizationModule,
    LecPageControlModule,
    SessionCleanupModule,
    TrashCleanupModule,
    RevocationModule,
    ScheduleModule.forRoot(),
  ],
  providers: [...WORKER_PROCESSORS, WorkerHealthService],
})
export class WorkerModule {}
