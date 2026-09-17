import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module';
import { PageLikeController } from './page-like.controller';
import { PageLikeService } from './page-like.service';

@Module({
  imports: [NotificationModule],
  controllers: [PageLikeController],
  providers: [PageLikeService],
})
export class PageLikeModule {}
