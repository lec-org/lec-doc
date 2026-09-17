import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module';
import { LecAuthorizationModule } from './lec-authorization.module';
import { LecPageControlService } from './lec-page-control.service';

@Module({
  imports: [LecAuthorizationModule, NotificationModule],
  providers: [LecPageControlService],
  exports: [LecPageControlService],
})
export class LecPageControlModule {}
