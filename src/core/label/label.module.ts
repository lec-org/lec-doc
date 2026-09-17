import { Module } from '@nestjs/common';
import { LabelController } from './label.controller';
import { LabelService } from './label.service';
import { LecAuthorizationModule } from '../lec-authorization/lec-authorization.module';

@Module({
  imports: [LecAuthorizationModule],
  controllers: [LabelController],
  providers: [LabelService],
  exports: [LabelService],
})
export class LabelModule {}
