import { Module } from '@nestjs/common';
import { CollaborationRevocationController } from './collaboration-revocation.controller';

@Module({
  controllers: [CollaborationRevocationController],
})
export class RevocationModule {}
