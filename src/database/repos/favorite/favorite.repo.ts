import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { InsertableFavorite, Favorite } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { ExpressionBuilder, SelectQueryBuilder, sql } from 'kysely';
import { DB } from '@docmost/db/types/db';
import { dbOrTx } from '@docmost/db/utils';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';

export const FavoriteType = {
  PAGE: 'page',
  SPACE: 'space',
  TEMPLATE: 'template',
} as const;

export type FavoriteType = (typeof FavoriteType)[keyof typeof FavoriteType];

@Injectable()
export class FavoriteRepo {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly spaceMemberRepo: SpaceMemberRepo,
  ) {}

  async insert(
    favorite: InsertableFavorite,
    trx?: KyselyTransaction,
  ): Promise<Favorite | undefined> {
    try {
      return await dbOrTx(this.db, trx)
        .insertInto('favorites')
        .values(favorite)
        .returningAll()
        .executeTakeFirst();
    } catch (err: any) {
      if (err?.code === '23505') return undefined;
      throw err;
    }
  }

  async deleteByUserAndPage(userId: string, pageId: string): Promise<void> {
    await this.db
      .deleteFrom('favorites')
      .where('userId', '=', userId)
      .where('pageId', '=', pageId)
      .execute();
  }

  async deleteByUserAndSpace(userId: string, spaceId: string): Promise<void> {
    await this.db
      .deleteFrom('favorites')
      .where('userId', '=', userId)
      .where('spaceId', '=', spaceId)
      .where('type', '=', FavoriteType.SPACE)
      .execute();
  }

  async deleteByUserAndTemplate(
    userId: string,
    templateId: string,
  ): Promise<void> {
    await this.db
      .deleteFrom('favorites')
      .where('userId', '=', userId)
      .where('templateId', '=', templateId)
      .execute();
  }

  async findFavoriteIdCandidates(
    userId: string,
    workspaceId: string,
    type: FavoriteType,
    spaceId: string | undefined,
    pagination: PaginationOptions,
  ) {
    const idColumn =
      type === FavoriteType.PAGE
        ? 'pageId'
        : type === FavoriteType.SPACE
          ? 'spaceId'
          : 'templateId';

    let query = this.db
      .selectFrom('favorites')
      .select([
        'favorites.id',
        `favorites.${idColumn} as entityId`,
        'favorites.workspaceId',
      ])
      .where('favorites.userId', '=', userId)
      .where('favorites.workspaceId', '=', workspaceId)
      .where('favorites.type', '=', type);

    query = this.applyMembershipFilter(query, userId);

    if (spaceId) {
      query = this.applySpaceFilter(query, type, spaceId);
    }

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      cursorPerRow: '$cursor',
      fields: [{ expression: 'favorites.id', direction: 'desc' }],
      parseCursor: (cursor) => ({ id: cursor.id }),
    });
  }

  async findUserFavoriteCandidates(
    userId: string,
    workspaceId: string,
    pagination: PaginationOptions,
    type?: FavoriteType,
    spaceId?: string,
  ) {
    let query = this.db
      .selectFrom('favorites')
      .select([
        'favorites.id',
        'favorites.type',
        'favorites.pageId',
        'favorites.spaceId',
        'favorites.workspaceId',
      ])
      .where('favorites.userId', '=', userId)
      .where('favorites.workspaceId', '=', workspaceId);

    query = this.applyMembershipFilter(query, userId);

    if (type) {
      query = query.where('favorites.type', '=', type);
    }

    if (spaceId) {
      query = this.applySpaceFilter(query, type, spaceId);
    }

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      cursorPerRow: '$cursor',
      fields: [{ expression: 'favorites.id', direction: 'desc' }],
      parseCursor: (cursor) => ({ id: cursor.id }),
    });
  }

  async findUserFavoriteContentByIds(
    favoriteIds: string[],
    type?: FavoriteType,
  ) {
    if (favoriteIds.length === 0) return [];
    let query = this.db
      .selectFrom('favorites')
      .selectAll('favorites')
      .where('favorites.id', 'in', favoriteIds);

    if (type === FavoriteType.PAGE || !type) {
      query = query.select((eb) => this.withPage(eb));
    }

    if (type === FavoriteType.PAGE) {
      query = query.select((eb) => this.withPageSpace(eb));
    } else if (type === FavoriteType.SPACE) {
      query = query.select((eb) => this.withSpace(eb));
    } else {
      query = query.select((eb) => this.withSpaceResolved(eb));
    }

    if (type === FavoriteType.TEMPLATE || !type) {
      query = query.select((eb) => this.withTemplate(eb));
    }

    return query.execute();
  }

  async deleteByUsersWithoutSpaceAccess(
    userIds: string[],
    spaceId: string,
    opts?: { trx?: KyselyTransaction },
  ): Promise<void> {
    if (userIds.length === 0) return;

    const { trx } = opts ?? {};
    const db = dbOrTx(this.db, trx);

    const usersWithAccess = db
      .selectFrom('spaceMembers')
      .select('userId')
      .where('spaceId', '=', spaceId)
      .where('userId', 'is not', null)
      .union(
        db
          .selectFrom('spaceMembers')
          .innerJoin('groupUsers', 'groupUsers.groupId', 'spaceMembers.groupId')
          .select('groupUsers.userId')
          .where('spaceMembers.spaceId', '=', spaceId),
      );

    await db
      .deleteFrom('favorites')
      .where('userId', 'in', userIds)
      .where((eb) =>
        eb.or([
          eb('spaceId', '=', spaceId),
          eb.exists(
            eb
              .selectFrom('pages')
              .select(sql`1`.as('one'))
              .whereRef('pages.id', '=', 'favorites.pageId')
              .where('pages.spaceId', '=', spaceId),
          ),
          eb.exists(
            eb
              .selectFrom('templates')
              .select(sql`1`.as('one'))
              .whereRef('templates.id', '=', 'favorites.templateId')
              .where('templates.spaceId', '=', spaceId),
          ),
        ]),
      )
      .where('userId', 'not in', usersWithAccess)
      .execute();
  }

  async deleteByUserAndWorkspace(
    userId: string,
    workspaceId: string,
    opts?: { trx?: KyselyTransaction },
  ): Promise<void> {
    const { trx } = opts;
    const db = dbOrTx(this.db, trx);

    await db
      .deleteFrom('favorites')
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  private applyMembershipFilter<Q extends SelectQueryBuilder<any, any, any>>(
    query: Q,
    userId: string,
  ): Q {
    const spaceIds = this.spaceMemberRepo.getUserSpaceIdsQuery(userId);
    return query.where((eb: any) =>
      eb.or([
        eb.and([
          eb('favorites.type', '=', FavoriteType.SPACE),
          eb('favorites.spaceId', 'in', spaceIds),
        ]),
        eb.and([
          eb('favorites.type', '=', FavoriteType.PAGE),
          eb.exists(
            eb
              .selectFrom('pages')
              .select(sql`1`.as('one'))
              .whereRef('pages.id', '=', 'favorites.pageId')
              .where('pages.spaceId', 'in', spaceIds),
          ),
        ]),
        eb.and([
          eb('favorites.type', '=', FavoriteType.TEMPLATE),
          eb.exists(
            eb
              .selectFrom('templates')
              .select(sql`1`.as('one'))
              .whereRef('templates.id', '=', 'favorites.templateId')
              .where((e: any) =>
                e.or([
                  e('templates.spaceId', 'is', null),
                  e('templates.spaceId', 'in', spaceIds),
                ]),
              ),
          ),
        ]),
      ]),
    ) as Q;
  }

  private applySpaceFilter<Q extends SelectQueryBuilder<any, any, any>>(
    query: Q,
    type: FavoriteType | undefined,
    spaceId: string,
  ): Q {
    if (type === FavoriteType.PAGE) {
      return query.where((eb: any) =>
        eb.exists(
          eb
            .selectFrom('pages')
            .select(sql`1`.as('one'))
            .whereRef('pages.id', '=', 'favorites.pageId')
            .where('pages.spaceId', '=', spaceId),
        ),
      ) as Q;
    }
    if (type === FavoriteType.SPACE) {
      return query.where('favorites.spaceId' as any, '=', spaceId) as Q;
    }
    if (type === FavoriteType.TEMPLATE) {
      return query.where((eb: any) =>
        eb.exists(
          eb
            .selectFrom('templates')
            .select(sql`1`.as('one'))
            .whereRef('templates.id', '=', 'favorites.templateId')
            .where('templates.spaceId', '=', spaceId),
        ),
      ) as Q;
    }
    return query;
  }

  private withPage(eb: ExpressionBuilder<DB, 'favorites'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('pages')
        .select([
          'pages.id',
          'pages.slugId',
          'pages.title',
          'pages.icon',
          'pages.isBase',
          'pages.spaceId',
        ])
        .whereRef('pages.id', '=', 'favorites.pageId')
        .where(sql.ref('favorites.type'), '=', FavoriteType.PAGE),
    ).as('page');
  }

  private withSpace(eb: ExpressionBuilder<DB, 'favorites'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('spaces')
        .select(['spaces.id', 'spaces.name', 'spaces.slug', 'spaces.logo'])
        .whereRef('spaces.id', '=', 'favorites.spaceId'),
    ).as('space');
  }

  private withPageSpace(eb: ExpressionBuilder<DB, 'favorites'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('spaces')
        .innerJoin('pages', 'pages.spaceId', 'spaces.id')
        .select(['spaces.id', 'spaces.name', 'spaces.slug', 'spaces.logo'])
        .whereRef('pages.id', '=', 'favorites.pageId'),
    ).as('space');
  }

  private withSpaceResolved(eb: ExpressionBuilder<DB, 'favorites'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('spaces')
        .select(['spaces.id', 'spaces.name', 'spaces.slug', 'spaces.logo'])
        .where(({ or, ref }) =>
          or([
            sql<boolean>`${ref('favorites.type')} = ${FavoriteType.SPACE} and ${ref('spaces.id')} = ${ref('favorites.spaceId')}`,
            sql<boolean>`${ref('favorites.type')} = ${FavoriteType.PAGE} and ${ref('spaces.id')} = (SELECT pages.space_id FROM pages WHERE pages.id = ${ref('favorites.pageId')})`,
          ]),
        ),
    ).as('space');
  }

  private withTemplate(eb: ExpressionBuilder<DB, 'favorites'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('templates')
        .select([
          'templates.id',
          'templates.title',
          'templates.description',
          'templates.icon',
          'templates.spaceId',
        ])
        .whereRef('templates.id', '=', 'favorites.templateId')
        .where(sql.ref('favorites.type'), '=', FavoriteType.TEMPLATE),
    ).as('template');
  }
}
