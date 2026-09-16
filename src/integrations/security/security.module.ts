import { Global, Module } from '@nestjs/common';
import { RobotsTxtController } from './robots.txt.controller';
import { VersionController } from './version.controller';
import { VersionService } from './version.service';
import { LecBrowserSecurity } from '../../core/auth/lec-browser-security';

@Global()
@Module({
  controllers: [RobotsTxtController, VersionController],
  providers: [VersionService, LecBrowserSecurity],
  exports: [LecBrowserSecurity],
})
export class SecurityModule {}
