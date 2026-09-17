import { Injectable } from '@nestjs/common';
import { SearchDTO, SearchSuggestionDTO } from './dto/search.dto';
import { SearchResponseDto } from './dto/search-response.dto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { sql } from 'kysely';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { LecAuthorizationService } from '../lec-authorization/lec-authorization.service';
import { User } from '@docmost/db/types/entity.types';
import { htmlEscape } from '../../common/helpers/html-escaper';

@Injectable()
export class SearchService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private pageRepo: PageRepo,
    private shareRepo: ShareRepo,
    private spaceMemberRepo: SpaceMemberRepo,
    private pagePermissionRepo: PagePermissionRepo,
    private lecAuthorization: LecAuthorizationService,
  ) {}

  async searchPage(
    searchParams: SearchDTO,
    opts: {
      user?: User;
      workspaceId: string;
      publicPageIds?: string[];
    },
  ): Promise<{ items: SearchResponseDto[] }> {
    const query = searchParams.query?.trim() ?? '';
    const labelIds = [...new Set(searchParams.labelIds ?? [])];
    // selected filters (labels, creator) are browsable without a query
    const browseByFilters =
      query.length < 1 &&
      (labelIds.length > 0 || Boolean(searchParams.creatorId));

    if (query.length < 1 && !browseByFilters) {
      return { items: [] };
    }
    const titleOnly = searchParams.titleOnly === true;
    const titleLikeQuery = query.replace(/[\\%_]/g, '\\$&');
    const normalizedQuery = sql<string>`lower(f_unaccent(${query}))`;
    const normalizedTitle = sql<string>`lower(coalesce(pages.title, ''))`;
    const normalizedText = sql<string>`lower(lec_search_unaccent(substring(coalesce(pages.text_content, ''), 1, 1000000)))`;
    const rankColumn = browseByFilters
      ? sql<number>`0`.as('rank')
      : titleOnly
        ? sql<number>`word_similarity(${normalizedQuery}, ${normalizedTitle})`.as(
            'rank',
          )
        : sql<number>`greatest(word_similarity(${normalizedQuery}, ${normalizedTitle}), word_similarity(${normalizedQuery}, ${normalizedText}))`.as(
            'rank',
          );

    let queryResults = this.db
      .selectFrom('pages')
      .select(['id', 'workspaceId', rankColumn])
      .$if(!browseByFilters && !titleOnly, (qb) =>
        qb.where((eb) =>
          eb.or([
            eb(
              normalizedTitle,
              'like',
              sql<string>`lower(f_unaccent(${`%${titleLikeQuery}%`}))`,
            ),
            eb(
              normalizedText,
              'like',
              sql<string>`lower(f_unaccent(${`%${titleLikeQuery}%`}))`,
            ),
          ]),
        ),
      )
      .$if(!browseByFilters && titleOnly, (qb) =>
        qb.where((eb) =>
          eb(
            normalizedTitle,
            'like',
            sql<string>`lower(f_unaccent(${`%${titleLikeQuery}%`}))`,
          ),
        ),
      )
      .$if(Boolean(searchParams.creatorId), (qb) =>
        qb.where('creatorId', '=', searchParams.creatorId),
      )
      .$if(labelIds?.length > 0, (qb) =>
        qb.where(
          'id',
          'in',
          this.db
            .selectFrom('pageLabels')
            .select('pageId')
            .where('labelId', 'in', labelIds),
        ),
      )
      .where('deletedAt', 'is', null)
      .$if(browseByFilters, (qb) => qb.orderBy('updatedAt', 'desc'))
      .$if(!browseByFilters, (qb) => qb.orderBy('rank', 'desc'))
      .orderBy('id', 'desc');

    if (searchParams.spaceId && opts.user) {
      queryResults = queryResults.where('spaceId', '=', searchParams.spaceId);
    } else if (opts.user && !searchParams.spaceId) {
      // only search spaces the user is a member of
      queryResults = queryResults
        .where(
          'spaceId',
          'in',
          this.spaceMemberRepo.getUserSpaceIdsQuery(opts.user.id),
        )
        .where('workspaceId', '=', opts.workspaceId);
    } else if (opts.publicPageIds && !opts.user) {
      // Public space search: the allowed id set is computed from live DB
      // state by the controller on every request.
      if (opts.publicPageIds.length === 0) {
        return { items: [] };
      }
      queryResults = queryResults
        .where('id', 'in', opts.publicPageIds)
        .where('workspaceId', '=', opts.workspaceId);
    } else if (searchParams.shareId && !searchParams.spaceId && !opts.user) {
      // search in shares
      const shareId = searchParams.shareId;
      const share = await this.shareRepo.findById(shareId);
      if (!share || share.workspaceId !== opts.workspaceId) {
        return { items: [] };
      }

      const isRestricted = await this.pagePermissionRepo.hasRestrictedAncestor(
        share.pageId,
      );
      if (isRestricted) {
        return { items: [] };
      }

      const pageIdsToSearch = [];
      if (share.includeSubPages) {
        const pageList =
          await this.pageRepo.getPageAndDescendantsExcludingRestricted(
            share.pageId,
            {
              includeContent: false,
            },
          );

        pageIdsToSearch.push(...pageList.map((page) => page.id));
      } else {
        pageIdsToSearch.push(share.pageId);
      }

      if (pageIdsToSearch.length > 0) {
        queryResults = queryResults
          .where('id', 'in', pageIdsToSearch)
          .where('workspaceId', '=', opts.workspaceId);
      } else {
        return { items: [] };
      }
    } else {
      return { items: [] };
    }

    const limit = Math.min(searchParams.limit || 25, 100);
    const requestedOffset = Math.max(searchParams.offset || 0, 0);
    const authorized: any[] = [];
    const candidateBatch = 100;
    const authorizedNeeded = requestedOffset + limit;
    for (let offset = 0; ; offset += candidateBatch) {
      let candidates: any[] = await queryResults
        .limit(candidateBatch)
        .offset(offset)
        .execute();
      if (candidates.length === 0) break;
      const candidateCount = candidates.length;
      const coreAllowed = await this.lecAuthorization.filterPages(
        candidates,
        opts.user ?? null,
      );
      const coreAllowedIds = new Set(coreAllowed.map((result) => result.id));
      candidates = candidates.filter((result: any) =>
        coreAllowedIds.has(result.id),
      );
      if (opts.user && candidates.length > 0) {
        const accessibleIds =
          await this.pagePermissionRepo.filterAccessiblePageIds({
            pageIds: candidates.map((result: any) => result.id),
            userId: opts.user.id,
            spaceId: searchParams.spaceId,
          });
        const accessibleSet = new Set(accessibleIds);
        candidates = candidates.filter((result: any) =>
          accessibleSet.has(result.id),
        );
      }
      if (authorized.length < authorizedNeeded) {
        authorized.push(
          ...candidates.slice(0, authorizedNeeded - authorized.length),
        );
      }
      if (candidateCount < candidateBatch) break;
    }
    const selected = authorized.slice(requestedOffset, requestedOffset + limit);
    if (selected.length === 0) return { items: [] };
    let contentQuery = this.db
      .selectFrom('pages')
      .select([
        'id',
        'slugId',
        'title',
        'icon',
        'parentPageId',
        'creatorId',
        'createdAt',
        'updatedAt',
        'textContent',
      ])
      .where(
        'id',
        'in',
        selected.map((result) => result.id),
      );
    if (!searchParams.shareId && !opts.publicPageIds)
      contentQuery = contentQuery.select((eb) => this.pageRepo.withSpace(eb));
    const content = await contentQuery.execute();
    const contentById = new Map(content.map((result) => [result.id, result]));
    const results = selected
      .map((candidate) => {
        const page = contentById.get(candidate.id);
        return {
          ...page,
          rank: candidate.rank,
          highlight:
            browseByFilters || titleOnly || !page?.textContent
              ? ''
              : this.highlight(page.textContent, query),
          textContent: undefined,
        };
      })
      .filter((result) => result.id);

    //@ts-ignore
    const searchResults = results.map((result: SearchResponseDto) => {
      result.wholeWord = false;
      result.matchedText = result.highlight ? [query] : [];
      return result;
    });

    return { items: searchResults };
  }

  async searchSuggestions(
    suggestion: SearchSuggestionDTO,
    user: User,
    workspaceId: string,
  ) {
    let users = [];
    let groups = [];
    let pages = [];

    const limit = suggestion?.limit || 10;
    const query = suggestion.query.toLowerCase().trim();

    if (suggestion.includeUsers) {
      const userQuery = this.db
        .selectFrom('users')
        .select(['id', 'name', 'email', 'avatarUrl'])
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .where((eb) =>
          eb.or([
            eb(
              sql`LOWER(f_unaccent(users.name))`,
              'like',
              sql`LOWER(f_unaccent(${`%${query}%`}))`,
            ),
            eb(sql`users.email`, 'ilike', sql`f_unaccent(${`%${query}%`})`),
          ]),
        )
        .limit(limit);

      users = await userQuery.execute();
    }

    if (suggestion.includeGroups) {
      groups = await this.db
        .selectFrom('groups')
        .select(['id', 'name', 'description'])
        .where((eb) =>
          eb(
            sql`LOWER(f_unaccent(groups.name))`,
            'like',
            sql`LOWER(f_unaccent(${`%${query}%`}))`,
          ),
        )
        .where('workspaceId', '=', workspaceId)
        .limit(limit)
        .execute();
    }

    if (suggestion.includePages) {
      const userSpaceIds = await this.spaceMemberRepo.getUserSpaceIds(user.id);
      if (userSpaceIds?.length > 0) {
        const escapedQuery = query.replace(/[\\%_]/g, '\\$&');
        const pageCandidates = this.db
          .selectFrom('pages')
          .select(['id', 'workspaceId'])
          .where(
            sql<string>`lower(f_unaccent(pages.title))`,
            'like',
            sql<string>`lower(f_unaccent(${`%${escapedQuery}%`}))`,
          )
          .where('deletedAt', 'is', null)
          .where('workspaceId', '=', workspaceId)
          .where('spaceId', 'in', userSpaceIds)
          .$if(Boolean(suggestion.spaceId), (qb) =>
            qb.orderBy(
              sql`CASE WHEN pages."space_id" = ${suggestion.spaceId} THEN 0 ELSE 1 END`,
              'asc',
            ),
          )
          .orderBy('updatedAt', 'desc')
          .orderBy('id', 'desc');
        const selected: { id: string; workspaceId: string }[] = [];
        for (let offset = 0; ; offset += 100) {
          let candidates = await pageCandidates
            .limit(100)
            .offset(offset)
            .execute();
          if (candidates.length === 0) break;
          const candidateCount = candidates.length;
          candidates = await this.lecAuthorization.filterPages(
            candidates,
            user,
          );
          if (candidates.length > 0) {
            const accessibleIds =
              await this.pagePermissionRepo.filterAccessiblePageIds({
                pageIds: candidates.map((page) => page.id),
                userId: user.id,
              });
            const accessible = new Set(accessibleIds);
            const allowed = candidates.filter((page) =>
              accessible.has(page.id),
            );
            if (selected.length < limit) {
              selected.push(...allowed.slice(0, limit - selected.length));
            }
          }
          if (candidateCount < 100) break;
        }
        const pageIds = selected.slice(0, limit).map((page) => page.id);
        if (pageIds.length > 0) {
          const content = await this.db
            .selectFrom('pages')
            .select(['id', 'slugId', 'title', 'icon', 'spaceId', 'workspaceId'])
            .select((eb) => this.pageRepo.withSpace(eb))
            .where('id', 'in', pageIds)
            .execute();
          const byId = new Map(content.map((page) => [page.id, page]));
          pages = pageIds.map((id) => byId.get(id)).filter(Boolean);
        }
      }
    }

    return { users, groups, pages };
  }

  private highlight(text: string, query: string) {
    const normalized = text.replace(/\s+/g, ' ');
    const index = normalized
      .toLocaleLowerCase()
      .indexOf(query.toLocaleLowerCase());
    if (index < 0) return '';
    const start = Math.max(0, index - 48);
    const end = Math.min(normalized.length, index + query.length + 96);
    return `${start > 0 ? '…' : ''}${htmlEscape(normalized.slice(start, index))}<b>${htmlEscape(normalized.slice(index, index + query.length))}</b>${htmlEscape(normalized.slice(index + query.length, end))}${end < normalized.length ? '…' : ''}`;
  }
}
