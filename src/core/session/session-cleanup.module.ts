import { Module } from '@nestjs/common';
import { TokenModule } from '../auth/token.module';
import { SessionService } from './session.service';

@Module({
  imports: [TokenModule],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionCleanupModule {}
