import { Extension, onAuthenticatePayload } from '@hocuspocus/server';
import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenService } from '../../core/auth/services/token.service';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { findHighestUserSpaceRole } from '@docmost/db/repos/space/utils';
import { SpaceRole } from '../../common/helpers/types/permission';
import { isUserDisabled } from '../../common/helpers';
import { getPageId } from '../collaboration.util';
import { JwtCollabPayload, JwtType } from '../../core/auth/dto/jwt-payload';
import { LecAuthorizationService } from '../../core/lec-authorization/lec-authorization.service';
import {
  beforeHandleAwarenessPayload,
  beforeHandleMessagePayload,
  beforeSyncPayload,
  onLoadDocumentPayload,
} from '@hocuspocus/server';

export type LecCollabContext = {
  user: Awaited<ReturnType<UserRepo['findById']>>;
  pageId: string;
  workspaceId: string;
  spaceId: string;
  writeCapability: 'EDIT' | 'COMMENT';
};

@Injectable()
export class AuthenticationExtension implements Extension {
  private readonly logger = new Logger(AuthenticationExtension.name);

  constructor(
    private tokenService: TokenService,
    private userRepo: UserRepo,
    private pageRepo: PageRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly authorization: LecAuthorizationService,
  ) {}

  async onAuthenticate(data: onAuthenticatePayload) {
    const { documentName, token } = data;
    const pageId = getPageId(documentName);

    let jwtPayload: JwtCollabPayload;

    try {
      jwtPayload = await this.tokenService.verifyJwt(token, JwtType.COLLAB);
    } catch (error) {
      throw new UnauthorizedException('Invalid collab token');
    }

    const userId = jwtPayload.sub;
    const workspaceId = jwtPayload.workspaceId;

    const user = await this.userRepo.findById(userId, workspaceId);

    if (!user) {
      throw new UnauthorizedException();
    }

    if (isUserDisabled(user)) {
      throw new UnauthorizedException();
    }

    const page = await this.pageRepo.findById(pageId);
    if (!page) {
      this.logger.debug(`Page not found: ${pageId}`);
      throw new NotFoundException('Page not found');
    }

    const userSpaceRoles = await this.spaceMemberRepo.getUserSpaceRoles(
      user.id,
      page.spaceId,
    );

    const userSpaceRole = findHighestUserSpaceRole(userSpaceRoles);

    if (!userSpaceRole) {
      this.logger.warn(`User not authorized to access page: ${pageId}`);
      throw new UnauthorizedException();
    }

    // Core decides all positive authorization; native ACLs only narrow it.
    const [view, edit] = await this.authorization.page(page, user, [
      'VIEW',
      'EDIT',
    ]);
    if (!view?.allowed) throw new UnauthorizedException();

    // Check page-level permissions
    const { hasAnyRestriction, canAccess, canEdit } =
      await this.pagePermissionRepo.canUserEditPage(user.id, page.id);

    if (hasAnyRestriction) {
      if (!canAccess) {
        this.logger.warn(
          `User ${user.id} denied page-level access to page: ${pageId}`,
        );
        throw new UnauthorizedException();
      }

      if (!canEdit) {
        data.connectionConfig.readOnly = true;
        this.logger.debug(
          `User ${user.id} granted readonly access to restricted page: ${pageId}`,
        );
      }
    } else {
      // No restrictions - use space-level permissions
      if (userSpaceRole === SpaceRole.READER) {
        data.connectionConfig.readOnly = true;
        this.logger.debug(`User granted readonly access to page: ${pageId}`);
      }
    }

    if (!edit?.allowed || page.deletedAt) data.connectionConfig.readOnly = true;

    this.logger.debug(`Authenticated user ${user.id} on page ${pageId}`);

    return {
      user,
      pageId,
      workspaceId,
      spaceId: page.spaceId,
      writeCapability: 'EDIT',
    } satisfies LecCollabContext;
  }

  async onLoadDocument(data: onLoadDocumentPayload<LecCollabContext>) {
    await this.require(data.context, 'VIEW');
  }

  async beforeHandleMessage(
    data: beforeHandleMessagePayload<LecCollabContext>,
  ) {
    try {
      await this.require(data.context, 'VIEW');
      if (!data.connection.readOnly)
        await this.require(data.context, data.context.writeCapability);
    } catch (error) {
      data.connection.close({ code: 4403, reason: 'authorization_revoked' });
      throw error;
    }
  }

  async beforeSync(data: beforeSyncPayload<LecCollabContext>) {
    try {
      await this.require(data.context, 'VIEW');
      if (data.type !== 0 && !data.connection.readOnly)
        await this.require(data.context, data.context.writeCapability);
    } catch (error) {
      data.connection.close({ code: 4403, reason: 'authorization_revoked' });
      throw error;
    }
  }

  async beforeHandleAwareness(
    data: beforeHandleAwarenessPayload<LecCollabContext>,
  ) {
    if (!data.context) return;
    try {
      await this.require(data.context, 'VIEW');
    } catch (error) {
      data.connection?.close({ code: 4403, reason: 'authorization_revoked' });
      throw error;
    }
  }

  private async require(
    context: LecCollabContext,
    capability: 'VIEW' | 'EDIT' | 'COMMENT',
  ) {
    if (!context?.user || !context.pageId || !context.workspaceId)
      throw new UnauthorizedException();
    await this.authorization.requirePage(
      {
        id: context.pageId,
        workspaceId: context.workspaceId,
        deletedAt: null,
      },
      context.user,
      capability,
    );
  }
}
