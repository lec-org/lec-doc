import { Module } from '@nestjs/common';
import { ImportService } from './services/import.service';
import { ImportController } from './import.controller';
import { StorageModule } from '../storage/storage.module';
import { FileImportTaskService } from './services/file-import-task.service';
import { ImportAttachmentService } from './services/import-attachment.service';
import { FileTaskController } from './file-task.controller';
import { PageMaintenanceModule } from '../../core/page/page-maintenance.module';
import { LecAuthorizationModule } from '../../core/lec-authorization/lec-authorization.module';

@Module({
  providers: [
    ImportService,
    FileImportTaskService,
    ImportAttachmentService,
  ],
  exports: [ImportService, FileImportTaskService, ImportAttachmentService],
  controllers: [ImportController, FileTaskController],
  imports: [StorageModule, PageMaintenanceModule, LecAuthorizationModule],
})
export class ImportModule {}
