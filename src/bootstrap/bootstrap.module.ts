import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DatabaseModule } from '../database/database.module';
import { EnvironmentModule } from '../integrations/environment/environment.module';
import { OutboundModule } from '../integrations/outbound/outbound.module';
import { LecAuthorizationModule } from '../core/lec-authorization/lec-authorization.module';
import { BootstrapWorkspaceService } from './bootstrap-workspace.service';

@Module({
  imports: [
    EnvironmentModule,
    DatabaseModule,
    EventEmitterModule.forRoot(),
    OutboundModule,
    LecAuthorizationModule,
  ],
  providers: [BootstrapWorkspaceService],
  exports: [BootstrapWorkspaceService],
})
export class BootstrapModule {}
