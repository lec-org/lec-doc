import { Module } from '@nestjs/common';
import { LecAuthorizationModule } from '../lec-authorization/lec-authorization.module';
import { LecImNotificationClient } from './lec-im-notification.client';
import { LecImNotificationDeliveryService } from './lec-im-notification-delivery.service';

@Module({
  imports: [LecAuthorizationModule],
  providers: [LecImNotificationClient, LecImNotificationDeliveryService],
  exports: [LecImNotificationClient, LecImNotificationDeliveryService],
})
export class NotificationBackgroundModule {}
