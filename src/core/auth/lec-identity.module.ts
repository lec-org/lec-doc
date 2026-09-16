import { Module } from '@nestjs/common';
import { LecIdentityService } from './lec-identity.service';

/** 身份映射供登录、HTTP、worker 和协作授权共用，避免引入 Auth/Workspace 循环依赖。 */
@Module({ providers: [LecIdentityService], exports: [LecIdentityService] })
export class LecIdentityModule {}
