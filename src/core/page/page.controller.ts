import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { PageService } from './services/page.service';
import { BacklinkService } from './services/backlink.service';
import { PageAccessService } from './page-access/page-access.service';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { MovePageDto, MovePageToSpaceDto } from './dto/move-page.dto';
import {
  DeletePageDto,
  PageHistoryIdDto,
  PageIdDto,
  PageInfoDto,
} from './dto/page.dto';
import { PageHistoryService } from './services/page-history.service';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OAuthScope } from '../../common/decorators/oauth-scope.decorator';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { Page, User, Workspace } from '@docmost/db/types/entity.types';
import { SidebarPageDto } from './dto/sidebar-page.dto';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { RecentPageDto } from './dto/recent-page.dto';
import { CreatedByUserDto } from './dto/created-by-user.dto';
import { DuplicatePageDto } from './dto/duplicate-page.dto';
import { DeletedPageDto } from './dto/deleted-page.dto';
import { BacklinksListDto } from './dto/backlink.dto';
import { LabelService } from '../label/label.service';
import { AddLabelsDto, RemoveLabelDto } from '../label/dto/label.dto';
import {
  jsonToHtml,
  jsonToMarkdown,
} from '../../collaboration/collaboration.util';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { getPageTitle } from '../../common/helpers';
import { LecAuthorizationService } from '../lec-authorization/lec-authorization.service';
import { LecResourceLifecycleService } from '../lec-authorization/lec-resource-lifecycle.service';
import { LecPageControlService } from '../lec-authorization/lec-page-control.service';
import { GrantPageViewDto } from '../lec-authorization/dto/page-grant.dto';
import {
  ClassifyPageDto,
  RequestPageAccessDto,
  ReviewPageAccessDto,
  RevokePageAccessDto,
  RevokePageGrantDto,
  TransferPageOwnerDto,
} from '../lec-authorization/dto/page-control.dto';

const CONTROL_VALIDATION = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
});

@UseGuards(JwtAuthGuard)
@Controller('pages')
export class PageController {
  constructor(
    private readonly pageService: PageService,
    private readonly pageRepo: PageRepo,
    private readonly pageHistoryService: PageHistoryService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly pageAccessService: PageAccessService,
    private readonly backlinkService: BacklinkService,
    private readonly labelService: LabelService,
    private readonly lecAuthorization: LecAuthorizationService,
    private readonly lifecycle: LecResourceLifecycleService,
    private readonly control: LecPageControlService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('/grant-view')
  @OAuthScope('write')
  grantView(
    @Body(CONTROL_VALIDATION)
    dto: GrantPageViewDto,
    @AuthUser() user: User,
  ) {
    return this.control.grantView(user, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('/classify')
  @OAuthScope('write')
  classify(
    @Body(CONTROL_VALIDATION)
    dto: ClassifyPageDto,
    @AuthUser() user: User,
  ) {
    return this.control.classify(user, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('/transfer-owner')
  @OAuthScope('write')
  transferOwner(
    @Body(CONTROL_VALIDATION)
    dto: TransferPageOwnerDto,
    @AuthUser() user: User,
  ) {
    return this.control.transferOwner(user, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('/revoke-grant')
  @OAuthScope('write')
  revokeGrant(
    @Body(CONTROL_VALIDATION)
    dto: RevokePageGrantDto,
    @AuthUser() user: User,
  ) {
    return this.control.revokeGrant(user, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('/request-access')
  @OAuthScope('write')
  requestAccess(
    @Body(CONTROL_VALIDATION)
    dto: RequestPageAccessDto,
    @AuthUser() user: User,
  ) {
    return this.control.requestAccess(user, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('/review-access')
  @OAuthScope('write')
  reviewAccess(
    @Body(CONTROL_VALIDATION)
    dto: ReviewPageAccessDto,
    @AuthUser() user: User,
  ) {
    return this.control.reviewAccess(user, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('/revoke-access')
  @OAuthScope('write')
  revokeAccess(
    @Body(CONTROL_VALIDATION)
    dto: RevokePageAccessDto,
    @AuthUser() user: User,
  ) {
    return this.control.revokeAccess(user, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('/info')
  @OAuthScope('read')
  async getPage(@Body() dto: PageInfoDto, @AuthUser() user: User) {
    const page = await this.pageRepo.findById(dto.pageId, {
      includeSpace: true,
      includeContent: true,
      includeCreator: true,
      includeLastUpdatedBy: true,
      includeContributors: true,
      includeDeletedBy: true,
    });

    if (!page) {
      throw new NotFoundException('Page not found');
    }

    const { canEdit, hasRestriction } =
      await this.pageAccessService.validateCanViewWithPermissions(page, user);

    const permissions = { canEdit, hasRestriction };

    if (dto.format && dto.format !== 'json' && page.content) {
      const contentOutput =
        dto.format === 'markdown'
          ? jsonToMarkdown(page.content)
          : jsonToHtml(page.content);
      return {
        ...page,
        content: contentOutput,
        permissions,
      };
    }

    return { ...page, permissions };
  }

  @HttpCode(HttpStatus.OK)
  @Post('labels')
  async getPageLabels(
    @Body() dto: PageIdDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
  ) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanView(page, user);

    return this.labelService.getPageLabels(page.id, pagination);
  }

  @HttpCode(HttpStatus.OK)
  @Post('labels/add')
  async addPageLabels(
    @Body() dto: AddLabelsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page || page.deletedAt) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanEdit(page, user);

    return this.labelService.addLabelsToPage(page.id, dto.names, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('labels/remove')
  async removePageLabel(@Body() dto: RemoveLabelDto, @AuthUser() user: User) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page || page.deletedAt) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanEdit(page, user);

    await this.labelService.removeLabelFromPage(
      page.id,
      dto.labelId,
      page.workspaceId,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('backlinks-count')
  async getBacklinksCount(
    @Body() dto: PageIdDto,
    @AuthUser() user: User,
  ): Promise<{ incoming: number; outgoing: number }> {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }
    await this.pageAccessService.validateCanView(page, user);

    return this.backlinkService.countByPageId(page.id, user);
  }

  @HttpCode(HttpStatus.OK)
  @Post('backlinks')
  async getBacklinks(
    @Body() dto: BacklinksListDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
  ) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }
    await this.pageAccessService.validateCanView(page, user);

    return this.backlinkService.findByPageId(
      page.id,
      dto.direction,
      user,
      pagination,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  @OAuthScope('write')
  async create(
    @Body() createPageDto: CreatePageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (createPageDto.parentPageId) {
      // Creating under a parent page - check edit permission on parent
      const parentPage = await this.pageRepo.findById(
        createPageDto.parentPageId,
      );
      if (
        !parentPage ||
        parentPage.deletedAt ||
        parentPage.spaceId !== createPageDto.spaceId
      ) {
        throw new NotFoundException('Parent page not found');
      }
      await this.pageAccessService.validateCanEdit(parentPage, user);
    } else {
      // Creating at root level - require space-level permission
      const ability = await this.spaceAbility.createForUser(
        user,
        createPageDto.spaceId,
      );
      if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }
    }

    const principal = await this.lecAuthorization.principal(user, workspace.id);
    if (principal.type !== 'OIDC') this.lecAuthorization.deny();
    const page = await this.pageService.create(user, principal, createPageDto);

    const { canEdit, hasRestriction } =
      await this.pageAccessService.validateCanViewWithPermissions(page, user);

    const permissions = { canEdit, hasRestriction };

    this.auditService.log({
      event: AuditEvent.PAGE_CREATED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      changes: {
        after: {
          title: getPageTitle(page.title),
          spaceId: page.spaceId,
        },
      },
    });

    if (
      createPageDto.format &&
      createPageDto.format !== 'json' &&
      page.content
    ) {
      const contentOutput =
        createPageDto.format === 'markdown'
          ? jsonToMarkdown(page.content)
          : jsonToHtml(page.content);
      return { ...page, content: contentOutput, permissions };
    }

    return { ...page, permissions };
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  @OAuthScope('write')
  async update(@Body() updatePageDto: UpdatePageDto, @AuthUser() user: User) {
    const page = await this.pageRepo.findById(updatePageDto.pageId);

    if (!page) {
      throw new NotFoundException('Page not found');
    }

    const { hasRestriction } = await this.pageAccessService.validateCanEdit(
      page,
      user,
    );

    const updatedPage = await this.pageService.update(
      page,
      updatePageDto,
      user,
    );

    const permissions = { canEdit: true, hasRestriction };

    if (
      updatePageDto.format &&
      updatePageDto.format !== 'json' &&
      updatedPage.content
    ) {
      const contentOutput =
        updatePageDto.format === 'markdown'
          ? jsonToMarkdown(updatedPage.content)
          : jsonToHtml(updatedPage.content);
      return { ...updatedPage, content: contentOutput, permissions };
    }

    return { ...updatedPage, permissions };
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async delete(
    @Body() deletePageDto: DeletePageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pageRepo.findById(deletePageDto.pageId);

    if (!page) {
      throw new NotFoundException('Page not found');
    }

    const ability = await this.spaceAbility.createForUser(user, page.spaceId);

    if (deletePageDto.permanentlyDelete) {
      if (ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)) {
        throw new ForbiddenException(
          'Only space admins can permanently delete pages',
        );
      }
      const pages = await this.pageRepo.getPageAndDescendants(page.id, {
        includeContent: false,
        includeDeleted: true,
      });
      const decisions = await this.lecAuthorization.requireTree(
        pages,
        user,
        'DELETE',
      );
      await this.lifecycle.requireDeletedTree(
        workspace.id,
        page.id,
        decisions.map((decision) => ({
          id: decision.resource_id,
          resourceVersion: decision.resource_version,
        })),
      );
      await this.pageService.forceDelete(deletePageDto.pageId, workspace.id);

      this.auditService.log({
        event: AuditEvent.PAGE_DELETED,
        resourceType: AuditResource.PAGE,
        resourceId: page.id,
        spaceId: page.spaceId,
        changes: {
          before: {
            pageId: page.id,
            slugId: page.slugId,
            title: getPageTitle(page.title),
            spaceId: page.spaceId,
          },
        },
      });
    } else {
      const pages = await this.pageRepo.getPageAndDescendants(page.id, {
        includeContent: false,
      });
      const decisions = await this.lecAuthorization.requireTree(
        pages,
        user,
        'DELETE',
      );
      const principal = await this.lecAuthorization.principal(
        user,
        workspace.id,
      );
      if (principal.type !== 'OIDC') this.lecAuthorization.deny();
      await this.lifecycle.deleteTree(
        user,
        principal,
        page.id,
        decisions.map((decision) => ({
          id: decision.resource_id,
          resourceVersion: decision.resource_version,
        })),
      );
      this.auditService.log({
        event: AuditEvent.PAGE_TRASHED,
        resourceType: AuditResource.PAGE,
        resourceId: page.id,
        spaceId: page.spaceId,
        changes: {
          before: {
            pageId: page.id,
            slugId: page.slugId,
            title: getPageTitle(page.title),
            spaceId: page.spaceId,
          },
        },
      });
    }
  }

  @HttpCode(HttpStatus.OK)
  @Post('restore')
  async restore(
    @Body() pageIdDto: PageIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pageRepo.findById(pageIdDto.pageId);

    if (!page) {
      throw new NotFoundException('Page not found');
    }

    const pages = await this.pageRepo.getPageAndDescendants(page.id, {
      includeContent: false,
      includeDeleted: true,
    });
    const decisions = await this.lecAuthorization.requireTree(
      pages,
      user,
      'RESTORE',
      page.id,
    );
    const deleteOperation = await this.lifecycle.findDeleteOperation(
      workspace.id,
      page.id,
    );
    const principal = await this.lecAuthorization.principal(user, workspace.id);
    if (principal.type !== 'OIDC') this.lecAuthorization.deny();
    await this.lifecycle.restoreTree(
      user,
      principal,
      page.id,
      deleteOperation.id,
      decisions.map((decision) => ({
        id: decision.resource_id,
        resourceVersion: decision.resource_version,
      })),
    );
    this.auditService.log({
      event: AuditEvent.PAGE_RESTORED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      changes: {
        after: {
          title: getPageTitle(page.title),
          spaceId: page.spaceId,
        },
      },
    });

    return this.pageRepo.findById(pageIdDto.pageId, {
      includeHasChildren: true,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('recent')
  @OAuthScope('read')
  async getRecentPages(
    @Body() recentPageDto: RecentPageDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
  ) {
    if (recentPageDto.spaceId) {
      const ability = await this.spaceAbility.createForUser(
        user,
        recentPageDto.spaceId,
      );

      if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }

      return this.pageService.getRecentSpacePages(
        recentPageDto.spaceId,
        user,
        pagination,
      );
    }

    return this.pageService.getRecentPages(user, pagination);
  }

  @HttpCode(HttpStatus.OK)
  @Post('created-by-user')
  async getCreatedByPages(
    @Body() dto: CreatedByUserDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
  ) {
    const targetUserId = dto.userId ?? user.id;

    if (dto.spaceId) {
      const ability = await this.spaceAbility.createForUser(user, dto.spaceId);

      if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }
    }

    return this.pageService.getCreatedByPages(
      targetUserId,
      user,
      pagination,
      dto.spaceId,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('trash')
  async getDeletedPages(
    @Body() deletedPageDto: DeletedPageDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
  ) {
    if (deletedPageDto.spaceId) {
      const ability = await this.spaceAbility.createForUser(
        user,
        deletedPageDto.spaceId,
      );

      if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }

      return this.pageService.getDeletedSpacePages(
        deletedPageDto.spaceId,
        user,
        pagination,
      );
    }
  }

  @HttpCode(HttpStatus.OK)
  @Post('/history')
  async getPageHistory(
    @Body() dto: PageIdDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
  ) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanView(page, user);

    return this.pageHistoryService.findHistoryByPageId(page.id, pagination);
  }

  @HttpCode(HttpStatus.OK)
  @Post('/history/info')
  async getPageHistoryInfo(
    @Body() dto: PageHistoryIdDto,
    @AuthUser() user: User,
  ) {
    const history = await this.pageHistoryService.findById(dto.historyId);
    if (!history) {
      throw new NotFoundException('Page history not found');
    }

    // Get the page to check permissions
    const page = await this.pageRepo.findById(history.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanView(page, user);

    return history;
  }

  @HttpCode(HttpStatus.OK)
  @Post('/sidebar-pages')
  @OAuthScope('read')
  async getSidebarPages(
    @Body() dto: SidebarPageDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
  ) {
    if (!dto.spaceId && !dto.pageId) {
      throw new BadRequestException(
        'Either spaceId or pageId must be provided',
      );
    }
    let spaceId = dto.spaceId;

    if (dto.pageId) {
      const page = await this.pageRepo.findAuthorizationSubject(dto.pageId);
      if (!page) {
        throw new ForbiddenException();
      }

      await this.pageAccessService.validateCanView(page, user);
      spaceId = page.spaceId;
    }

    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    const spaceCanEdit = ability.can(
      SpaceCaslAction.Edit,
      SpaceCaslSubject.Page,
    );

    return this.pageService.getSidebarPages(
      spaceId,
      pagination,
      dto.pageId,
      user,
      spaceCanEdit,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('move-to-space')
  @OAuthScope('write')
  movePageToSpace(@Body() _dto: MovePageToSpaceDto, @AuthUser() _user: User) {
    throw new ForbiddenException(
      'Lec Doc v1 does not permit moving pages between spaces',
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('duplicate')
  @OAuthScope('write')
  async duplicatePage(@Body() dto: DuplicatePageDto, @AuthUser() user: User) {
    const copiedPage = await this.pageRepo.findAuthorizationSubject(dto.pageId);
    if (!copiedPage) {
      throw new NotFoundException('Page to copy not found');
    }

    let result;

    // If spaceId is provided, it's a copy to different space
    if (dto.spaceId) {
      const abilities = await Promise.all([
        this.spaceAbility.createForUser(user, copiedPage.spaceId),
        this.spaceAbility.createForUser(user, dto.spaceId),
      ]);

      if (
        abilities.some((ability) =>
          ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page),
        )
      ) {
        throw new ForbiddenException();
      }

      result = await this.pageService.duplicatePage(
        copiedPage,
        dto.spaceId,
        user,
      );

      this.auditService.log({
        event: AuditEvent.PAGE_DUPLICATED,
        resourceType: AuditResource.PAGE,
        resourceId: result.id,
        spaceId: dto.spaceId,
        metadata: {
          sourcePageId: copiedPage.id,
          title: getPageTitle(result.title),
          sourceSpaceId: copiedPage.spaceId,
          targetSpaceId: dto.spaceId,
          ...(result.childPageIds.length > 0 && {
            childPageIds: result.childPageIds,
          }),
        },
      });
    } else {
      // If no spaceId, it's a duplicate in same space
      const ability = await this.spaceAbility.createForUser(
        user,
        copiedPage.spaceId,
      );
      if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }

      result = await this.pageService.duplicatePage(
        copiedPage,
        undefined,
        user,
      );

      this.auditService.log({
        event: AuditEvent.PAGE_DUPLICATED,
        resourceType: AuditResource.PAGE,
        resourceId: result.id,
        spaceId: copiedPage.spaceId,
        metadata: {
          sourcePageId: copiedPage.id,
          title: getPageTitle(result.title),
          ...(result.childPageIds.length > 0 && {
            childPageIds: result.childPageIds,
          }),
        },
      });
    }

    return result;
  }

  @HttpCode(HttpStatus.OK)
  @Post('move')
  @OAuthScope('write')
  async movePage(@Body() dto: MovePageDto, @AuthUser() user: User) {
    const movedPage = await this.pageRepo.findById(dto.pageId);
    if (!movedPage) {
      throw new NotFoundException('Moved page not found');
    }

    const ability = await this.spaceAbility.createForUser(
      user,
      movedPage.spaceId,
    );

    if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    // Local ACL narrows Core; the lifecycle obtains the authoritative source
    // EDIT version immediately before prepare.
    await this.pageAccessService.validateCanEdit(movedPage, user, false);

    // If moving to a new parent, check permission on the target parent
    if (dto.parentPageId && dto.parentPageId !== movedPage.parentPageId) {
      const targetParent = await this.pageRepo.findById(dto.parentPageId);
      if (!targetParent || targetParent.deletedAt) {
        throw new NotFoundException('Target parent page not found');
      }
      await this.pageAccessService.validateCanEdit(targetParent, user);
    }

    const principal = await this.lecAuthorization.principal(
      user,
      movedPage.workspaceId,
    );
    if (principal.type !== 'OIDC') this.lecAuthorization.deny();
    const decision = await this.lecAuthorization.requirePage(
      movedPage,
      user,
      'EDIT',
    );
    return this.lifecycle.movePage(
      user,
      principal,
      movedPage.id,
      decision.resource_version,
      dto.parentPageId ? 'DOCMOST_PAGE' : 'DOCMOST_SPACE',
      dto.parentPageId ?? movedPage.spaceId,
      (trx) => this.pageService.movePage(dto, movedPage, trx),
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('/breadcrumbs')
  async getPageBreadcrumbs(@Body() dto: PageIdDto, @AuthUser() user: User) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanView(page, user);
    const ancestors = await this.pageService.getPageBreadCrumbs(page.id);
    return this.lecAuthorization.filterPages(ancestors, user);
  }
}
