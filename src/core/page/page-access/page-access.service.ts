import { ForbiddenException, Injectable } from '@nestjs/common';
import { Page, User } from '@docmost/db/types/entity.types';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import SpaceAbilityFactory from '../../casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../casl/interfaces/space-ability.type';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { LecAuthorizationService } from '../../lec-authorization/lec-authorization.service';

@Injectable()
export class PageAccessService {
  constructor(
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly spaceRepo: SpaceRepo,
    private readonly lec: LecAuthorizationService,
  ) {}

  // 本地 Space/CASL/PagePermission 只收紧 Core 已允许的能力，不产生独立 allow。
  async localPermissions(
    page: Pick<Page, 'id' | 'spaceId'>,
    user: User,
  ) {
    const { hasAnyRestriction, canAccess, canEdit } =
      await this.pagePermissionRepo.canUserEditPage(user.id, page.id);
    const grant = await this.pagePermissionRepo.findActiveLecGrant(
      page.id,
      user.id,
    );
    if (hasAnyRestriction) {
      if (!canAccess && !grant) throw new ForbiddenException();
      if (canAccess) return { canEdit, hasRestriction: true };
      return { canEdit: false, hasRestriction: true };
    }
    try {
      const ability = await this.spaceAbility.createForUser(user, page.spaceId);
      return {
        canEdit: ability.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page),
        hasRestriction: false,
      };
    } catch {
      if (grant) return { canEdit: false, hasRestriction: false };
      throw new ForbiddenException();
    }
  }

  async validateCanView(
    page: Pick<Page, 'id' | 'workspaceId' | 'deletedAt' | 'spaceId'>,
    user: User,
  ): Promise<void> {
    await this.lec.requirePage(page, user, 'VIEW');
    await this.localPermissions(page, user);
  }

  async validateCanViewWithPermissions(
    page: Page,
    user: User,
  ): Promise<{ canEdit: boolean; hasRestriction: boolean }> {
    const [view, edit] = await this.lec.page(page, user, ['VIEW', 'EDIT']);
    if (!view?.allowed) this.lec.deny();
    const local = await this.localPermissions(page, user);
    return { ...local, canEdit: !!edit?.allowed && local.canEdit };
  }

  async validateCanEdit(
    page: Pick<Page, 'id' | 'workspaceId' | 'deletedAt' | 'spaceId'>,
    user: User,
    requireCore: boolean = true,
  ): Promise<{ hasRestriction: boolean }> {
    if (requireCore) await this.lec.requirePage(page, user, 'EDIT');
    const local = await this.localPermissions(page, user);
    if (!local.canEdit) throw new ForbiddenException();
    return { hasRestriction: local.hasRestriction };
  }

  async validateCanComment(
    page: Page,
    user: User,
    workspaceId: string,
  ): Promise<void> {
    if (workspaceId !== page?.workspaceId) this.lec.deny();
    await this.lec.requirePage(page, user, 'COMMENT');
    const local = await this.localPermissions(page, user);
    if (local.canEdit) return;
    const space = await this.spaceRepo.findById(page.spaceId, workspaceId);
    const settings = space?.settings as Record<string, any> | null;
    if (!settings?.comments?.allowViewerComments)
      throw new ForbiddenException();
  }
}
