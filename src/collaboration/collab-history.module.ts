import { Module } from '@nestjs/common';
import { CollabHistoryService } from './services/collab-history.service';

@Module({
  providers: [CollabHistoryService],
  exports: [CollabHistoryService],
})
export class CollabHistoryModule {}
