import { Module } from '@nestjs/common';
import { TransclusionController } from './transclusion.controller';
import { TransclusionService } from './transclusion.service';
import { LecAuthorizationModule } from '../../lec-authorization/lec-authorization.module';

@Module({
  imports: [LecAuthorizationModule],
  controllers: [TransclusionController],
  providers: [TransclusionService],
  exports: [TransclusionService],
})
export class TransclusionModule {}
