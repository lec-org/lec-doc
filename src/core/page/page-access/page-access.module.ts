import { Global, Module } from '@nestjs/common';
import { PageAccessService } from './page-access.service';
import { LecAuthorizationModule } from '../../lec-authorization/lec-authorization.module';

@Global()
@Module({
  imports: [LecAuthorizationModule],
  providers: [PageAccessService],
  exports: [PageAccessService],
})
export class PageAccessModule {}
