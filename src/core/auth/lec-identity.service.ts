import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { GroupUserRepo } from '@docmost/db/repos/group/group-user.repo';
import {
  SpaceRole,
  UserRole,
} from '../../common/helpers/types/permission';
import { isUserDisabled } from '../../common/helpers';
import { getWorkspaceDefaultPageEditMode } from '../workspace/workspace.util';
import { LecTenantPrincipal } from './lec-oidc.client';

const EMAIL_CONFLICT =
  '此邮箱已关联其他账号，请联系管理员显式绑定；不会自动合并账号';

function personalSpaceSlug(userId: string) {
  return `personal-${randomUUID().replaceAll('-', '')}-${userId.slice(0, 8)}`;
}

@Injectable()
export class LecIdentityService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly users: UserRepo,
    private readonly groups: GroupUserRepo,
  ) {}

  private async ensureDefaultPersonalSpace(
    userId: string,
    realName: string,
    workspaceId: string,
    principal: Pick<LecTenantPrincipal, 'issuer' | 'subject' | 'organizationId'>,
    trx: KyselyTransaction,
  ) {
    const existing = await trx
      .selectFrom('spaces')
      .select(['id', 'name'])
      .where('workspaceId', '=', workspaceId)
      .where('creatorId', '=', userId)
      .where('isDefaultPersonal', '=', true)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (existing) {
      if (existing.name !== realName)
        await trx
          .updateTable('spaces')
          .set({ name: realName, updatedAt: new Date() })
          .where('id', '=', existing.id)
          .execute();
      await trx
        .insertInto('spaceMembers')
        .values({ spaceId: existing.id, userId, role: SpaceRole.ADMIN })
        .onConflict((oc) =>
          oc.columns(['spaceId', 'userId']).doUpdateSet({
            role: SpaceRole.ADMIN,
            deletedAt: null,
            updatedAt: new Date(),
          }),
        )
        .execute();
      await this.ensureSpaceBindIntent(
        existing.id,
        userId,
        workspaceId,
        principal,
        trx,
      );
      return;
    }
    const space = await trx
      .insertInto('spaces')
      .values({
        name: realName,
        description: '',
        slug: personalSpaceSlug(userId),
        creatorId: userId,
        workspaceId,
        isPersonal: true,
        isDefaultPersonal: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('spaceMembers')
      .values({ spaceId: space.id, userId, role: SpaceRole.ADMIN })
      .execute();
    await this.ensureSpaceBindIntent(
      space.id,
      userId,
      workspaceId,
      principal,
      trx,
    );
  }

  private async ensureSpaceBindIntent(
    spaceId: string,
    userId: string,
    workspaceId: string,
    principal: Pick<LecTenantPrincipal, 'issuer' | 'subject' | 'organizationId'>,
    trx: KyselyTransaction,
  ) {
    await trx
      .insertInto('lecResourceOperations')
      .values({
        id: randomUUID(),
        workspaceId,
        resourceKind: 'DOCMOST_SPACE',
        resourceId: spaceId,
        action: 'BIND_SPACE',
        status: 'BIND_PENDING',
        registrationKey: randomUUID(),
        actorUserId: userId,
        actorIssuer: principal.issuer,
        actorSubject: principal.subject,
        payload: { organizationId: principal.organizationId, personal: true },
        availableAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  findByUserId(userId: string, workspaceId: string) {
    return this.db
      .selectFrom('lecIdentities')
      .select(['issuer', 'subject'])
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  async resolve(workspaceId: string, principal: LecTenantPrincipal) {
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
              ...(principal.avatarUrl !== undefined
                ? { avatarUrl: principal.avatarUrl }
                : {}),
              role: principal.tenantRole,
              emailVerifiedAt: new Date(),
              lastLoginAt: new Date(),
            },
            existing.id,
            workspaceId,
            trx,
          );
          const updated = await this.users.findById(existing.id, workspaceId, {
            trx,
          });
          await this.ensureDefaultPersonalSpace(
            updated.id,
            principal.realName,
            workspaceId,
            principal,
            trx,
          );
          return updated;
        }
        const user = await this.users.insertUser(
          {
            name: principal.name,
            email: principal.email,
            emailVerifiedAt: new Date(),
            avatarUrl: principal.avatarUrl ?? null,
            password: null,
            workspaceId,
            role: principal.tenantRole,
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
        await this.ensureDefaultPersonalSpace(
          user.id,
          principal.realName,
          workspaceId,
          principal,
          trx,
        );
        return user;
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === '23505')
        throw new ConflictException(EMAIL_CONFLICT);
      throw error;
    }
  }
}
