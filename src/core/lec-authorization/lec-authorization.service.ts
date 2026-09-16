import { ForbiddenException, Injectable } from '@nestjs/common';
import { Page, User } from '@docmost/db/types/entity.types';
import { isUserDisabled } from '../../common/helpers';
import { LecIdentityService } from '../auth/lec-identity.service';
import { LecPolicyClient } from './lec-policy.client';
import { LecCapability, LecPolicyItem, LecPrincipal } from './lec-policy.types';

@Injectable()
export class LecAuthorizationService {
  constructor(
    private readonly identities: LecIdentityService,
    private readonly policy: LecPolicyClient,
  ) {}

  async principal(
    user: User | null,
    workspaceId: string,
  ): Promise<LecPrincipal> {
    if (user === null) return { type: 'ANONYMOUS' };
    if (!user || user.workspaceId !== workspaceId || isUserDisabled(user))
      this.deny();
    const identity = await this.identities.findByUserId(user.id, workspaceId);
    if (!identity) this.deny();
    return { type: 'OIDC', ...identity };
  }

  async check(user: User | null, workspaceId: string, items: LecPolicyItem[]) {
    return this.policy.authorize(
      workspaceId,
      await this.principal(user, workspaceId),
      items,
    );
  }

  /** 正文、元数据、编辑和评论共用；缺少资源/身份始终拒绝，不能回落到本地角色。 */
  async page(
    page: Pick<Page, 'id' | 'workspaceId' | 'deletedAt'>,
    user: User | null,
    capabilities: LecCapability[],
  ) {
    if (!page || page.deletedAt) this.deny();
    return this.check(
      user,
      page.workspaceId,
      capabilities.map((capability) => ({
        resource_kind: 'DOCMOST_PAGE',
        resource_id: page.id,
        capability,
      })),
    );
  }

  async requirePage(page: Page, user: User, capability: LecCapability) {
    const [decision] = await this.page(page, user, [capability]);
    if (!decision?.allowed) this.deny();
    return decision;
  }

  async requireTree(
    pages: Pick<Page, 'id' | 'workspaceId'>[],
    user: User,
    capability: 'DELETE' | 'RESTORE',
    rootId: string = pages[0]?.id,
  ) {
    if (!pages.length) this.deny();
    const workspaceId = pages[0].workspaceId;
    if (pages.some((page) => page.workspaceId !== workspaceId)) this.deny();
    const decisions = await this.check(
      user,
      workspaceId,
      pages.map((page) => ({
        resource_kind: 'DOCMOST_PAGE',
        resource_id: page.id,
        capability,
      })),
    );
    if (
      capability === 'DELETE'
        ? decisions.some((decision) => !decision.allowed)
        : !decisions.find(
            (decision) => decision.resource_id === rootId && decision.allowed,
          )
    )
      this.deny();
    return decisions;
  }

  deny(): never {
    throw new ForbiddenException({
      code: 'DOC_FORBIDDEN',
      message: '没有文档访问权限',
    });
  }
}
