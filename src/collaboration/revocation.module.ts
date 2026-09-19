import { Module } from '@nestjs/common';
import { CollaborationRevocationController } from './collaboration-revocation.controller';
import { EntitlementProjectionService } from './entitlement-projection.service';

@Module({
  controllers: [CollaborationRevocationController],
  providers: [EntitlementProjectionService],
})
export class RevocationModule {}
