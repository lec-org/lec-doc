import { Module } from '@nestjs/common';
import { FavoriteService } from './services/favorite.service';
import { FavoriteController } from './favorite.controller';
import { LecAuthorizationModule } from '../lec-authorization/lec-authorization.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [LecAuthorizationModule, NotificationModule],
  controllers: [FavoriteController],
  providers: [FavoriteService],
  exports: [FavoriteService],
})
export class FavoriteModule {}
