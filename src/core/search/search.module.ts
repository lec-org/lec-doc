import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { PublicSpaceModule } from '../public-space/public-space.module';
import { LecAuthorizationModule } from '../lec-authorization/lec-authorization.module';

@Module({
  imports: [PublicSpaceModule, LecAuthorizationModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
