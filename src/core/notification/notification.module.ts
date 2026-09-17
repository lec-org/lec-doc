import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { CommentNotificationService } from './services/comment.notification';
import { PageNotificationService } from './services/page.notification';
import { VerificationNotificationService } from './services/verification.notification';
import { PageUpdateEmailRateLimiter } from './services/page-update-email-rate-limiter';
import { LecAuthorizationModule } from '../lec-authorization/lec-authorization.module';
import { NotificationBackgroundModule } from './notification-background.module';

@Module({
  imports: [LecAuthorizationModule, NotificationBackgroundModule],
  controllers: [NotificationController],
  providers: [
    NotificationService,
    CommentNotificationService,
    PageNotificationService,
    VerificationNotificationService,
    PageUpdateEmailRateLimiter,
  ],
  exports: [
    NotificationService,
    CommentNotificationService,
    PageNotificationService,
    VerificationNotificationService,
  ],
})
export class NotificationModule {}
