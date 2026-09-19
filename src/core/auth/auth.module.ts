import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './services/auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { WorkspaceModule } from '../workspace/workspace.module';
import { SignupService } from './services/signup.service';
import { TokenModule } from './token.module';
import { LecOidcClient } from './lec-oidc.client';
import { LecOidcTransactions } from './lec-oidc-transactions';
import { LecIdentityModule } from './lec-identity.module';
import { LecOidcController } from './lec-oidc.controller';
import { LecDesktopHandoffController } from './lec-desktop-handoff.controller';
import { LecDesktopHandoffService } from './lec-desktop-handoff.service';
import { LecCoreProfileClient } from './lec-core-profile.client';

@Module({
  imports: [TokenModule, WorkspaceModule, LecIdentityModule],
  controllers: [
    AuthController,
    LecOidcController,
    LecDesktopHandoffController,
  ],
  providers: [
    AuthService,
    SignupService,
    JwtStrategy,
    LecOidcClient,
    LecOidcTransactions,
    LecDesktopHandoffService,
    LecCoreProfileClient,
  ],
  exports: [SignupService],
})
export class AuthModule {}
