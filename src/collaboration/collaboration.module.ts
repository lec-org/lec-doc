import { Module } from '@nestjs/common';
import { AuthenticationExtension } from './extensions/authentication.extension';
import { PersistenceExtension } from './extensions/persistence.extension';
import { CollaborationGateway } from './collaboration.gateway';
import { TokenModule } from '../core/auth/token.module';
import { LoggerExtension } from './extensions/logger.extension';
import { CollaborationHandler } from './collaboration.handler';
import { CollabHistoryModule } from './collab-history.module';
import { TransclusionService } from '../core/page/transclusion/transclusion.service';
import { PageAccessModule } from '../core/page/page-access/page-access.module';
import { StorageModule } from '../integrations/storage/storage.module';
import { EnvironmentModule } from '../integrations/environment/environment.module';
import { LecAuthorizationModule } from '../core/lec-authorization/lec-authorization.module';

@Module({
  providers: [
    CollaborationGateway,
    AuthenticationExtension,
    PersistenceExtension,
    LoggerExtension,
    CollaborationHandler,
    TransclusionService,
  ],
  exports: [CollaborationGateway],
  imports: [
    TokenModule,
    CollabHistoryModule,
    StorageModule.forRootAsync({
      imports: [EnvironmentModule],
    }),
    PageAccessModule,
    LecAuthorizationModule,
  ],
})
export class CollaborationModule {}
