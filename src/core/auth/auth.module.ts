import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './services/auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { WorkspaceModule } from '../workspace/workspace.module';
import { SignupService } from './services/signup.service';
import { TokenModule } from './token.module';
import { LecOidcClient } from './lec-oidc.client';
import { LecOidcTransactions } from './lec-oidc-transactions';
import { LecIdentityService } from './lec-identity.service';
import { LecOidcController } from './lec-oidc.controller';

@Module({
  imports: [TokenModule, WorkspaceModule],
  controllers: [AuthController, LecOidcController],
  providers: [
    AuthService,
    SignupService,
    JwtStrategy,
    LecOidcClient,
    LecOidcTransactions,
    LecIdentityService,
  ],
  exports: [SignupService],
})
export class AuthModule {}
