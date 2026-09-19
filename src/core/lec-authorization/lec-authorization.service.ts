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

  async requireSpace(
    spaceId: string,
    workspaceId: string,
    user: User | null,
    capability: LecCapability,
  ) {
    const [decision] = await this.check(user, workspaceId, [
      {
        resource_kind: 'DOCMOST_SPACE',
        resource_id: spaceId,
        capability,
      },
    ]);
    if (!decision?.allowed) this.deny();
    return decision;
  }

  async requirePage(
    page: Pick<Page, 'id' | 'workspaceId' | 'deletedAt'>,
    user: User | null,
    capability: LecCapability,
  ) {
    const [decision] = await this.page(page, user, [capability]);
    if (!decision?.allowed) this.deny();
    return decision;
  }

  async filterPages<T extends Pick<Page, 'id' | 'workspaceId'>>(
    pages: T[],
    user: User | null,
    capability: LecCapability = 'VIEW',
  ): Promise<T[]> {
    if (!pages.length) return [];
    const workspaceId = pages[0].workspaceId;
    if (pages.some((page) => page.workspaceId !== workspaceId)) this.deny();
    const allowed = new Set<string>();
    for (let index = 0; index < pages.length; index += 100) {
      const chunk = pages.slice(index, index + 100);
      const decisions = await this.check(
        user,
        workspaceId,
        chunk.map((page) => ({
          resource_kind: 'DOCMOST_PAGE',
          resource_id: page.id,
          capability,
        })),
      );
      decisions.forEach((decision) => {
        if (decision.allowed) allowed.add(decision.resource_id);
      });
    }
    return pages.filter((page) => allowed.has(page.id));
  }

  async filterSpaces<
    T extends { id: string; workspaceId: string },
  >(
    spaces: T[],
    user: User | null,
  ): Promise<T[]> {
    if (!spaces.length) return [];
    const workspaceId = spaces[0].workspaceId;
    if (spaces.some((space) => space.workspaceId !== workspaceId)) this.deny();
    const allowed = new Set<string>();
    for (let index = 0; index < spaces.length; index += 100) {
      const chunk = spaces.slice(index, index + 100);
      const decisions = await this.check(
        user,
        workspaceId,
        chunk.map((space) => ({
          resource_kind: 'DOCMOST_SPACE',
          resource_id: space.id,
          capability: 'VIEW',
        })),
      );
      decisions.forEach((decision) => {
        if (decision.allowed) allowed.add(decision.resource_id);
      });
    }
    return spaces.filter((space) => allowed.has(space.id));
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
