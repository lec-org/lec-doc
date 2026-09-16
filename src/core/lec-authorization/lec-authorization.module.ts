import { Module } from '@nestjs/common';
import { LecIdentityModule } from '../auth/lec-identity.module';
import { OutboundModule } from '../../integrations/outbound/outbound.module';
import { LecPolicyClient } from './lec-policy.client';
import { LecAuthorizationService } from './lec-authorization.service';
import { LecResourceLifecycleService } from './lec-resource-lifecycle.service';

@Module({
  imports: [LecIdentityModule, OutboundModule],
  providers: [
    LecPolicyClient,
    LecAuthorizationService,
    LecResourceLifecycleService,
  ],
  exports: [
    LecPolicyClient,
    LecAuthorizationService,
    LecResourceLifecycleService,
  ],
})
export class LecAuthorizationModule {}
