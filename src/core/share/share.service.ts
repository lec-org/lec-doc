import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateShareDto, ShareInfoDto, UpdateShareDto } from './dto/share.dto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { nanoIdGen } from '../../common/helpers';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { TokenService } from '../auth/services/token.service';
import { jsonToNode } from '../../collaboration/collaboration.util';
import {
  getAttachmentIds,
  getProsemirrorContent,
  isAttachmentNode,
  removeMarkTypeFromDoc,
} from '../../common/helpers/prosemirror/utils';
import { Node } from '@tiptap/pm/model';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { updateAttachmentAttr } from './share.util';
import { Page, User } from '@docmost/db/types/entity.types';
import { validate as isValidUUID } from 'uuid';
import { sql } from 'kysely';
import { TransclusionService } from '../page/transclusion/transclusion.service';
import { TransclusionLookup } from '../page/transclusion/transclusion.types';
import { LecAuthorizationService } from '../lec-authorization/lec-authorization.service';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';

@Injectable()
export class ShareService {
  private readonly logger = new Logger(ShareService.name);

  constructor(
    private readonly shareRepo: ShareRepo,
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly tokenService: TokenService,
    private readonly transclusionService: TransclusionService,
    private readonly authorization: LecAuthorizationService,
  ) {}

  async getShares(user: User, pagination: PaginationOptions) {
    const limit = pagination.limit;
    const backwards = Boolean(pagination.beforeCursor && !pagination.cursor);
    let cursor = pagination.cursor;
    let beforeCursor = pagination.beforeCursor;
    let exhausted = false;
    let lastScannedCursor: string | undefined;
    let authorized: Array<{
      id: string;
      pageId: string;
      workspaceId: string;
      $cursor: string;
    }> = [];

    for (let scanned = 0; scanned < 1000; scanned += 100) {
      const batch = await this.shareRepo.findCandidates(
        user.id,
        user.workspaceId,
        { limit: 100, cursor, beforeCursor } as PaginationOptions,
      );
      const candidates = batch.items;
      if (candidates.length === 0) {
        exhausted = true;
        break;
      }

      const coreAllowed = await this.authorization.filterPages(
        candidates.map((share) => ({
          id: share.pageId,
          workspaceId: share.workspaceId,
        })),
        user,
      );
      const accessibleIds =
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds: coreAllowed.map((page) => page.id),
          userId: user.id,
        });
      const accessible = new Set(accessibleIds);
      const allowed = candidates.filter((share) =>
        accessible.has(share.pageId),
      );
      authorized = backwards
        ? [...allowed, ...authorized]
        : [...authorized, ...allowed];

      if (backwards) {
        lastScannedCursor = candidates[0].$cursor;
        beforeCursor = lastScannedCursor;
        exhausted = !batch.meta.hasNextPage;
      } else {
        lastScannedCursor = candidates[candidates.length - 1].$cursor;
        cursor = batch.meta.nextCursor ?? undefined;
        exhausted = !cursor;
      }
      if (authorized.length >= limit || exhausted) break;
    }

    const selected = backwards
      ? authorized.slice(-limit)
      : authorized.slice(0, limit);
    const selectedIds = selected.map((share) => share.id);
    const content = selectedIds.length
      ? await this.shareRepo.findContentByIds(selectedIds, user.id)
      : [];
    const byId = new Map(content.map((share) => [share.id, share]));
    const items = selectedIds.map((id) => byId.get(id)).filter(Boolean);
    const hasMore = authorized.length > limit || !exhausted;
    const firstCursor = selected[0]?.$cursor ?? lastScannedCursor ?? null;
    const lastCursor =
      selected[selected.length - 1]?.$cursor ?? lastScannedCursor ?? null;

    return {
      items,
      meta: {
        limit,
        hasNextPage: backwards ? Boolean(pagination.beforeCursor) : hasMore,
        hasPrevPage: backwards ? hasMore : Boolean(pagination.cursor),
        nextCursor: backwards
          ? pagination.beforeCursor
            ? lastCursor
            : null
          : hasMore
            ? lastCursor
            : null,
        prevCursor: backwards
          ? hasMore
            ? firstCursor
            : null
          : pagination.cursor
            ? firstCursor
            : null,
      },
    };
  }

  async getShareTree(shareId: string, workspaceId: string) {
    const share = await this.shareRepo.findById(shareId);
    if (!share || share.workspaceId !== workspaceId) {
      throw new NotFoundException('Share not found');
    }

    const candidates = share.includeSubPages
      ? await this.pageRepo.findPageTreeCandidates(share.pageId)
      : [await this.pageRepo.findAuthorizationSubject(share.pageId)].filter(
          Boolean,
        );
    const allowed = await this.authorization.filterPages(candidates, null);
    if (!allowed.some((page) => page.id === share.pageId)) {
      throw new NotFoundException('Share not found');
    }

    const isRestricted = await this.pagePermissionRepo.hasRestrictedAncestor(
      share.pageId,
    );
    if (isRestricted) {
      throw new NotFoundException('Share not found');
    }

    if (share.includeSubPages) {
      const pageTree =
        await this.pageRepo.getPageAndDescendantsExcludingRestricted(
          share.pageId,
          {
            includeContent: false,
            pageIds: allowed.map((page) => page.id),
          },
        );

      return { share, pageTree };
    } else {
      return { share, pageTree: [] };
    }
  }

  async createShare(opts: {
    authUserId: string;
    workspaceId: string;
    page: Pick<Page, 'id' | 'spaceId'>;
    createShareDto: CreateShareDto;
  }) {
    const { authUserId, workspaceId, page, createShareDto } = opts;

    try {
      const shares = await this.shareRepo.findByPageId(page.id);
      if (shares) {
        return shares;
      }

      return await this.shareRepo.insertShare({
        key: nanoIdGen().toLowerCase(),
        pageId: page.id,
        includeSubPages: createShareDto.includeSubPages ?? false,
        searchIndexing: createShareDto.searchIndexing ?? false,
        creatorId: authUserId,
        spaceId: page.spaceId,
        workspaceId,
      });
    } catch (err) {
      this.logger.error(err);
      throw new BadRequestException('Failed to share page');
    }
  }

  async updateShare(shareId: string, updateShareDto: UpdateShareDto) {
    try {
      return this.shareRepo.updateShare(
        {
          includeSubPages: updateShareDto.includeSubPages,
          searchIndexing: updateShareDto.searchIndexing,
        },
        shareId,
      );
    } catch (err) {
      this.logger.error(err);
      throw new BadRequestException('Failed to update share');
    }
  }

  async getSharedPage(
    dto: ShareInfoDto,
    workspaceId: string,
    opts?: { includeContent?: boolean },
  ) {
    //TODO: we should resolve the page from the share id
    if (!dto.pageId) throw new NotFoundException('Shared page not found');

    const candidate = await this.pageRepo.findAuthorizationSubject(dto.pageId);
    if (!candidate || candidate.workspaceId !== workspaceId) {
      throw new NotFoundException('Shared page not found');
    }
    try {
      await this.authorization.requirePage(candidate, null, 'VIEW');
    } catch {
      throw new NotFoundException('Shared page not found');
    }

    const share = await this.getShareForPage(dto.pageId, workspaceId);
    if (!share) {
      throw new NotFoundException('Shared page not found');
    }

    const includeContent = opts?.includeContent !== false;
    const page = includeContent
      ? await this.pageRepo.findById(dto.pageId, {
          includeContent: true,
          includeCreator: true,
        })
      : await this.pageRepo.findById(dto.pageId);

    if (!page || page.deletedAt) {
      throw new NotFoundException('Shared page not found');
    }

    // Block access to restricted pages
    const isRestricted = await this.pagePermissionRepo.hasRestrictedAncestor(
      page.id,
    );
    if (isRestricted) {
      throw new NotFoundException('Shared page not found');
    }

    if (includeContent) {
      page.content = await this.updatePublicAttachments(page);
    }

    return { page, share };
  }

  async getPublicShareInfo(shareId: string) {
    const candidateShare = await this.shareRepo.findById(shareId);
    if (!candidateShare) {
      throw new NotFoundException('Share not found');
    }

    const candidate = await this.pageRepo.findAuthorizationSubject(
      candidateShare.pageId,
    );
    if (!candidate || candidate.workspaceId !== candidateShare.workspaceId) {
      throw new NotFoundException('Share not found');
    }
    try {
      await this.authorization.requirePage(candidate, null, 'VIEW');
    } catch {
      throw new NotFoundException('Share not found');
    }

    const share = await this.shareRepo.findById(shareId, {
      includeSharedPage: true,
    });
    if (!share) {
      throw new NotFoundException('Share not found');
    }
    return share;
  }

  async getShareForPage(pageId: string, workspaceId: string) {
    // here we try to check if a page was shared directly or if it inherits the share from its closest shared ancestor
    const share = await this.db
      .withRecursive('page_hierarchy', (cte) =>
        cte
          .selectFrom('pages')
          .leftJoin('shares', 'shares.pageId', 'pages.id')
          .select([
            'pages.id',
            'pages.slugId',
            'pages.title',
            'pages.icon',
            'pages.parentPageId',
            sql`0`.as('level'),
            'shares.id as shareId',
            'shares.key as shareKey',
            'shares.includeSubPages',
            'shares.searchIndexing',
            'shares.creatorId',
            'shares.spaceId',
            'shares.workspaceId',
            'shares.createdAt',
          ])
          .where(isValidUUID(pageId) ? 'pages.id' : 'pages.slugId', '=', pageId)
          .where('pages.deletedAt', 'is', null)
          .unionAll(
            (union) =>
              union
                .selectFrom('pages as p')
                .innerJoin('page_hierarchy as ph', 'ph.parentPageId', 'p.id')
                .leftJoin('shares as s', 's.pageId', 'p.id')
                .select([
                  'p.id',
                  'p.slugId',
                  'p.title',
                  'p.icon',
                  'p.parentPageId',
                  sql`ph.level + 1`.as('level'),
                  's.id as shareId',
                  's.key as shareKey',
                  's.includeSubPages',
                  's.searchIndexing',
                  's.creatorId',
                  's.spaceId',
                  's.workspaceId',
                  's.createdAt',
                ])
                .where('p.deletedAt', 'is', null)
                .where(sql`ph.share_id`, 'is', null) // stop if share found
                .where(sql`ph.level`, '<', sql`25`), // prevent loop
          ),
      )
      .selectFrom('page_hierarchy')
      .selectAll()
      .where('shareId', 'is not', null)
      .limit(1)
      .executeTakeFirst();

    if (!share || share.workspaceId !== workspaceId) {
      return undefined;
    }

    if ((share.level as number) > 0 && !share.includeSubPages) {
      return undefined;
    }

    return {
      id: share.shareId,
      key: share.shareKey,
      includeSubPages: share.includeSubPages,
      searchIndexing: share.searchIndexing,
      pageId: share.id,
      creatorId: share.creatorId,
      spaceId: share.spaceId,
      workspaceId: share.workspaceId,
      createdAt: share.createdAt,
      level: share.level,
      sharedPage: {
        id: share.id,
        slugId: share.slugId,
        title: share.title,
        icon: share.icon,
      },
    };
  }

  async getShareAncestorPage(
    ancestorPageId: string,
    childPageId: string,
  ): Promise<any> {
    let ancestor = null;
    try {
      ancestor = await this.db
        .withRecursive('page_ancestors', (db) =>
          db
            .selectFrom('pages')
            .select([
              'id',
              'slugId',
              'title',
              'parentPageId',
              'spaceId',
              (eb) =>
                eb
                  .case()
                  .when(eb.ref('id'), '=', ancestorPageId)
                  .then(true)
                  .else(false)
                  .end()
                  .as('found'),
            ])
            .where(isValidUUID(childPageId) ? 'id' : 'slugId', '=', childPageId)
            .unionAll((exp) =>
              exp
                .selectFrom('pages as p')
                .select([
                  'p.id',
                  'p.slugId',
                  'p.title',
                  'p.parentPageId',
                  'p.spaceId',
                  (eb) =>
                    eb
                      .case()
                      .when(eb.ref('p.id'), '=', ancestorPageId)
                      .then(true)
                      .else(false)
                      .end()
                      .as('found'),
                ])
                .innerJoin('page_ancestors as pa', 'pa.parentPageId', 'p.id')
                // Continue recursing only when the target ancestor hasn't been found on that branch.
                .where('pa.found', '=', false),
            ),
        )
        .selectFrom('page_ancestors')
        .selectAll()
        .where('found', '=', true)
        .limit(1)
        .executeTakeFirst();
    } catch (err) {
      // empty
    }

    return ancestor;
  }

  /**
   * Resolve transclusion content for a public share viewer. Each requested
   * source page must itself be reachable via the share graph (its own share
   * or a shared ancestor with `includeSubPages`), in the same workspace as
   * the requesting share, with sharing allowed and no restricted ancestors.
   * Sources that don't qualify come back as `no_access` so the editor renders
   * the existing placeholder. The viewer's personal permissions are
   * intentionally ignored — share-served content is gated only by the share
   * graph.
   */
  async lookupTransclusionForShare(
    shareId: string,
    references: Array<{ sourcePageId: string; transclusionId: string }>,
    workspaceId: string,
  ): Promise<{ items: TransclusionLookup[] }> {
    const share = await this.shareRepo.findById(shareId);
    if (!share || share.workspaceId !== workspaceId) {
      throw new NotFoundException('Share not found');
    }
    const sharingAllowed = await this.isSharingAllowed(
      workspaceId,
      share.spaceId,
    );
    if (!sharingAllowed) {
      throw new NotFoundException('Share not found');
    }

    const candidatePageIds = Array.from(
      new Set(references.map((r) => r.sourcePageId)),
    );

    // TODO: Reduce DB round trips at scale by replacing the per-page chain
    // with bulk repo methods that take all candidate pageIds at once:
    //   - shareRepo.getSharesForPages(pageIds, workspaceId): Map<pageId, share>
    //   - pagePermissionRepo.filterRestrictedPageIds(pageIds): Set<pageId>
    //   - isSharingAllowed for the distinct spaceIds in one query
    // Brings per-request trip count from ~2N+1 (parallel) to 3 (constant)
    // for N unique candidate pages. Worth doing if profiling ever flags it.

    // Most candidates will share the host share's space, so cache by spaceId
    // and seed with the host space we just verified. Stores in-flight
    // promises so concurrent chains de-dupe at the request boundary.
    const sharingAllowedCache = new Map<string, Promise<boolean>>();
    sharingAllowedCache.set(share.spaceId, Promise.resolve(true));
    const isSharingAllowedFor = (spaceId: string) => {
      const cached = sharingAllowedCache.get(spaceId);
      if (cached) return cached;
      const p = this.isSharingAllowed(workspaceId, spaceId);
      sharingAllowedCache.set(spaceId, p);
      return p;
    };

    // Per-page chains run in parallel; wall time is the slowest chain, not
    // the sum. Each chain still does its 2–3 queries sequentially because
    // each step gates the next.
    const accessibleResults = await Promise.all(
      candidatePageIds.map(async (pageId) => {
        const sourceShare = await this.getShareForPage(pageId, workspaceId);
        if (!sourceShare) return null;
        if (!(await isSharingAllowedFor(sourceShare.spaceId))) return null;
        try {
          await this.authorization.requirePage(
            { id: pageId, workspaceId, deletedAt: null },
            null,
            'VIEW',
          );
        } catch {
          return null;
        }
        const restricted =
          await this.pagePermissionRepo.hasRestrictedAncestor(pageId);
        if (restricted) return null;
        return pageId;
      }),
    );
    const accessibleSet = new Set<string>(
      accessibleResults.filter((id): id is string => id !== null),
    );

    const { items } = await this.transclusionService.lookupWithAccessSet(
      references,
      accessibleSet,
      workspaceId,
    );

    return {
      items: await this.sanitizeTransclusionItemsForPublic(items, workspaceId),
    };
  }

  async isSharingAllowed(
    workspaceId: string,
    spaceId: string,
  ): Promise<boolean> {
    const result = await this.db
      .selectFrom('workspaces')
      .innerJoin('spaces', 'spaces.workspaceId', 'workspaces.id')
      .select([
        'workspaces.settings as workspaceSettings',
        'spaces.settings as spaceSettings',
      ])
      .where('workspaces.id', '=', workspaceId)
      .where('spaces.id', '=', spaceId)
      .executeTakeFirst();

    if (!result) return false;

    const workspaceDisabled =
      (result.workspaceSettings as any)?.sharing?.disabled === true;
    const spaceDisabled =
      (result.spaceSettings as any)?.sharing?.disabled === true;

    return !workspaceDisabled && !spaceDisabled;
  }

  async updatePublicAttachments(page: Page): Promise<any> {
    const doc = await this.prepareContentForShare(
      page.content,
      page.id,
      page.workspaceId,
    );
    return doc?.toJSON() ?? page.content;
  }

  /**
   * Sanitization tail shared by every public transclusion surface: tokenize
   * each content item against its source page, then hide lookup misses.
   */
  async sanitizeTransclusionItemsForPublic(
    items: TransclusionLookup[],
    workspaceId: string,
  ): Promise<TransclusionLookup[]> {
    const tokenized = await Promise.all(
      items.map(async (item) => {
        if ('status' in item) return item;
        const doc = await this.prepareContentForShare(
          item.content,
          item.sourcePageId,
          workspaceId,
        );
        return { ...item, content: doc?.toJSON() ?? item.content };
      }),
    );

    // Collapse not_found to no_access so hidden sources are indistinguishable from missing ids.
    return tokenized.map((item) =>
      'status' in item && item.status === 'not_found'
        ? {
            sourcePageId: item.sourcePageId,
            transclusionId: item.transclusionId,
            status: 'no_access' as const,
          }
        : item,
    );
  }

  /**
   * Prepare a ProseMirror JSON doc for delivery to a public share viewer.
   * Performs the two transforms required by the share threat model:
   *
   * 1. Mint a per-attachment public token scoped to `attachmentOwnerPageId`
   *    and rewrite each attachment node's `src`/`url` to the public form
   *    (`/files/public/...?jwt=`). The receiver enforces
   *    `attachment.pageId === token.pageId`, which is why the owner page id
   *    has to be passed in explicitly: the host page for direct shared
   *    content, the source page for transcluded source-block content
   *    (attachments in a sync block were uploaded onto the source page).
   *
   * 2. Strip `comment` marks. Comments are internal-team metadata and must
   *    not leak structure (existence, location, count, resolved state, or
   *    comment ids) to public viewers.
   *
   * Both share-content paths — the host page (`updatePublicAttachments`) and
   * the share-scoped transclusion lookup (`lookupTransclusionForShare`) —
   * call into this single helper so the two paths can never drift on
   * sanitization rules.
   */
  private async prepareContentForShare(
    content: unknown,
    attachmentOwnerPageId: string,
    workspaceId: string,
  ): Promise<Node | null> {
    const pmJson = getProsemirrorContent(content);
    const attachmentIds = getAttachmentIds(pmJson);

    const tokenMap = new Map<string, string>();
    await Promise.all(
      attachmentIds.map(async (attachmentId: string) => {
        const token = await this.tokenService.generateAttachmentToken({
          attachmentId,
          pageId: attachmentOwnerPageId,
          workspaceId,
        });
        tokenMap.set(attachmentId, token);
      }),
    );

    const doc = jsonToNode(pmJson);
    doc?.descendants((node: Node) => {
      if (!isAttachmentNode(node.type.name)) return;
      const token = tokenMap.get(node.attrs.attachmentId);
      if (!token) return;
      updateAttachmentAttr(node, 'src', token);
      updateAttachmentAttr(node, 'url', token);
    });

    return doc ? removeMarkTypeFromDoc(doc, 'comment') : null;
  }
}
