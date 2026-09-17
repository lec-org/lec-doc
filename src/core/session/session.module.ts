import { Global, Module } from '@nestjs/common';
import { SessionActivityService } from './session-activity.service';
import { SessionController } from './session.controller';
import { SessionCleanupModule } from './session-cleanup.module';

@Global()
@Module({
  imports: [SessionCleanupModule],
  controllers: [SessionController],
  providers: [SessionActivityService],
  exports: [SessionCleanupModule, SessionActivityService],
})
export class SessionModule {}
