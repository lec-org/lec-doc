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
  private async localPermissions(page: Page, user: User) {
    const ability = await this.spaceAbility.createForUser(user, page.spaceId);
    if (!ability.can(SpaceCaslAction.Read, SpaceCaslSubject.Page))
      throw new ForbiddenException();
    const { hasAnyRestriction, canAccess, canEdit } =
      await this.pagePermissionRepo.canUserEditPage(user.id, page.id);
    if (hasAnyRestriction && !canAccess) throw new ForbiddenException();
    return {
      canEdit: hasAnyRestriction
        ? canEdit
        : ability.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page),
      hasRestriction: hasAnyRestriction,
    };
  }

  async validateCanView(page: Page, user: User): Promise<void> {
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
    page: Page,
    user: User,
  ): Promise<{ hasRestriction: boolean }> {
    await this.lec.requirePage(page, user, 'EDIT');
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
