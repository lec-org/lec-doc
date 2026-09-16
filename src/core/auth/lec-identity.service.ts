import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { GroupUserRepo } from '@docmost/db/repos/group/group-user.repo';
import { UserRole } from '../../common/helpers/types/permission';
import { isUserDisabled } from '../../common/helpers';
import { getWorkspaceDefaultPageEditMode } from '../workspace/workspace.util';
import { LecOidcPrincipal } from './lec-oidc.client';

const EMAIL_CONFLICT =
  '此邮箱已关联其他账号，请联系管理员显式绑定；不会自动合并账号';

@Injectable()
export class LecIdentityService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly users: UserRepo,
    private readonly groups: GroupUserRepo,
  ) {}

  findByUserId(userId: string, workspaceId: string) {
    return this.db
      .selectFrom('lecIdentities')
      .select(['issuer', 'subject'])
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  async resolve(workspaceId: string, principal: LecOidcPrincipal) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        // ponytail: 单 workspace 串行 JIT/profile 更新；登录吞吐成为瓶颈后再细化为主体/邮箱锁。
        const workspace = await trx
          .selectFrom('workspaces')
          .selectAll()
          .where('id', '=', workspaceId)
          .where('deletedAt', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!workspace) throw new UnauthorizedException('工作区不可用');
        const binding = await trx
          .selectFrom('lecIdentities')
          .selectAll()
          .where('workspaceId', '=', workspaceId)
          .where('issuer', '=', principal.issuer)
          .where('subject', '=', principal.subject)
          .executeTakeFirst();
        const existing = binding
          ? await this.users.findById(binding.userId, workspaceId, { trx })
          : undefined;
        if (binding && (!existing || isUserDisabled(existing)))
          throw new UnauthorizedException('账号已停用');
        const sameEmail = await this.users.findByEmail(
          principal.email,
          workspaceId,
          { trx },
        );
        if (sameEmail && sameEmail.id !== existing?.id)
          throw new ConflictException(EMAIL_CONFLICT);
        if (existing) {
          await this.users.updateUser(
            {
              name: principal.name,
              email: principal.email,
              emailVerifiedAt: new Date(),
              lastLoginAt: new Date(),
            },
            existing.id,
            workspaceId,
            trx,
          );
          return this.users.findById(existing.id, workspaceId, { trx });
        }
        const user = await this.users.insertUser(
          {
            name: principal.name,
            email: principal.email,
            emailVerifiedAt: new Date(),
            password: null,
            workspaceId,
            role: UserRole.MEMBER,
          },
          trx,
          {
            passwordless: true,
            pageEditMode: getWorkspaceDefaultPageEditMode(workspace),
          },
        );
        await this.groups.addUserToDefaultGroup(user.id, workspaceId, trx);
        await trx
          .insertInto('lecIdentities')
          .values({
            workspaceId,
            userId: user.id,
            issuer: principal.issuer,
            subject: principal.subject,
          })
          .execute();
        return user;
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === '23505')
        throw new ConflictException(EMAIL_CONFLICT);
      throw error;
    }
  }
}
