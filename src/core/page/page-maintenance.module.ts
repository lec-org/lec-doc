import { Module } from '@nestjs/common';
import { LecAuthorizationModule } from '../lec-authorization/lec-authorization.module';
import { PageMaintenanceService } from './services/page-maintenance.service';

@Module({
  imports: [LecAuthorizationModule],
  providers: [PageMaintenanceService],
  exports: [PageMaintenanceService],
})
export class PageMaintenanceModule {}
