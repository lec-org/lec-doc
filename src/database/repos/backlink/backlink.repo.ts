import {
  Backlink,
  InsertableBacklink,
  UpdatableBacklink,
} from '@docmost/db/types/entity.types';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx } from '@docmost/db/utils';
import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { sql } from 'kysely';

@Injectable()
export class BacklinkRepo {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly spaceMemberRepo: SpaceMemberRepo,
  ) {}

  async findById(
    backlinkId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<Backlink> {
    const db = dbOrTx(this.db, trx);

    return db
      .selectFrom('backlinks')
      .select([
        'id',
        'sourcePageId',
        'targetPageId',
        'workspaceId',
        'createdAt',
        'updatedAt',
      ])
      .where('id', '=', backlinkId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  async insertBacklink(
    insertableBacklink: InsertableBacklink,
    trx?: KyselyTransaction,
  ) {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('backlinks')
      .values(insertableBacklink)
      .onConflict((oc) =>
        oc.columns(['sourcePageId', 'targetPageId']).doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
  }

  async updateBacklink(
    updatableBacklink: UpdatableBacklink,
    backlinkId: string,
    trx?: KyselyTransaction,
  ) {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('userTokens')
      .set(updatableBacklink)
      .where('id', '=', backlinkId)
      .execute();
  }

  async deleteBacklink(
    backlinkId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db.deleteFrom('backlinks').where('id', '=', backlinkId).execute();
  }

  async findRelatedPageCandidates(
    pageId: string,
    direction: 'incoming' | 'outgoing',
    userId: string,
    workspaceId: string,
    pagination: PaginationOptions,
  ) {
    const relatedColumn =
      direction === 'incoming'
        ? 'backlinks.sourcePageId'
        : 'backlinks.targetPageId';
    const pageColumn =
      direction === 'incoming'
        ? 'backlinks.targetPageId'
        : 'backlinks.sourcePageId';
    const query = this.db
      .selectFrom('backlinks')
      .innerJoin('pages', 'pages.id', relatedColumn)
      .select(['pages.id', 'pages.workspaceId', 'pages.updatedAt'])
      .where(pageColumn, '=', pageId)
      .where('backlinks.workspaceId', '=', workspaceId)
      .where('pages.workspaceId', '=', workspaceId)
      .where(
        sql<boolean>`EXISTS (
          SELECT 1
          FROM pages anchor
          WHERE anchor.id = ${pageId}::uuid
            AND anchor.workspace_id = ${workspaceId}::uuid
            AND anchor.deleted_at IS NULL
        )`,
      )
      .where('pages.deletedAt', 'is', null)
      .where(
        'pages.spaceId',
        'in',
        this.spaceMemberRepo.getUserSpaceIdsQuery(userId),
      );

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      cursorPerRow: '$cursor',
      fields: [
        { expression: 'pages.updatedAt', direction: 'desc', key: 'updatedAt' },
        { expression: 'pages.id', direction: 'desc', key: 'id' },
      ],
      parseCursor: (cursor) => ({
        updatedAt: new Date(cursor.updatedAt),
        id: cursor.id,
      }),
    });
  }

  async findPageContentByIds(pageIds: string[], workspaceId: string) {
    if (pageIds.length === 0) return [];
    return this.db
      .selectFrom('pages')
      .select((eb) => [
        'pages.id',
        'pages.slugId',
        'pages.title',
        'pages.icon',
        'pages.spaceId',
        'pages.updatedAt',
        jsonObjectFrom(
          eb
            .selectFrom('spaces')
            .select(['spaces.id', 'spaces.slug', 'spaces.name'])
            .whereRef('spaces.id', '=', 'pages.spaceId'),
        ).as('space'),
      ])
      .where('pages.workspaceId', '=', workspaceId)
      .where('pages.deletedAt', 'is', null)
      .where('pages.id', 'in', pageIds)
      .execute();
  }
}
