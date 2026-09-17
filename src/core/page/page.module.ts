import { Module } from '@nestjs/common';
import { PageService } from './services/page.service';
import { PageController } from './page.controller';
import { PageHistoryService } from './services/page-history.service';
import { BacklinkService } from './services/backlink.service';
import { StorageModule } from '../../integrations/storage/storage.module';
import { CollaborationModule } from '../../collaboration/collaboration.module';
import { WatcherModule } from '../watcher/watcher.module';
import { TransclusionModule } from './transclusion/transclusion.module';
import { LabelModule } from '../label/label.module';
import { LecAuthorizationModule } from '../lec-authorization/lec-authorization.module';
import { LecPageControlModule } from '../lec-authorization/lec-page-control.module';
import { PageMaintenanceModule } from './page-maintenance.module';
import { TrashCleanupModule } from './trash-cleanup.module';

@Module({
  controllers: [PageController],
  providers: [
    PageService,
    PageHistoryService,
    BacklinkService,
  ],
  exports: [PageService, PageHistoryService],
  imports: [
    StorageModule,
    CollaborationModule,
    WatcherModule,
    TransclusionModule,
    LabelModule,
    LecAuthorizationModule,
    LecPageControlModule,
    PageMaintenanceModule,
    TrashCleanupModule,
  ],
})
export class PageModule {}
