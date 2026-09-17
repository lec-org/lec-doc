import { Module } from '@nestjs/common';
import { PageMaintenanceModule } from './page-maintenance.module';
import { TrashCleanupService } from './services/trash-cleanup.service';

@Module({
  imports: [PageMaintenanceModule],
  providers: [TrashCleanupService],
  exports: [TrashCleanupService],
})
export class TrashCleanupModule {}
