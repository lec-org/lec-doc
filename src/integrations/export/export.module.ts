import { Module } from '@nestjs/common';
import { ExportService } from './export.service';
import { ExportController } from './export.controller';
import { StorageModule } from '../storage/storage.module';
import { LecAuthorizationModule } from '../../core/lec-authorization/lec-authorization.module';

@Module({
  imports: [StorageModule, LecAuthorizationModule],
  providers: [ExportService],
  controllers: [ExportController],
})
export class ExportModule {}
