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
import { PageAccessService } from '../../core/page/page-access/page-access.service';
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
    private readonly pageAccess: PageAccessService,
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

    // Core decides positive authorization; the shared local predicate handles
    // space membership, native restrictions, and page-only grant fallback.
    const [view, edit] = await this.authorization.page(page, user, [
      'VIEW',
      'EDIT',
    ]);
    if (!view?.allowed) throw new UnauthorizedException();
    const local = await this.pageAccess.localPermissions(page, user);
    if (!edit?.allowed || !local.canEdit || page.deletedAt)
      data.connectionConfig.readOnly = true;

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
    const page = await this.pageRepo.findById(context.pageId);
    if (!page || page.workspaceId !== context.workspaceId)
      throw new UnauthorizedException();
    await this.authorization.requirePage(page, context.user, capability);
    const local = await this.pageAccess.localPermissions(page, context.user);
    if (capability !== 'VIEW' && !local.canEdit)
      throw new UnauthorizedException();
  }
}
