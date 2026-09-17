import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx } from '@docmost/db/utils';

@Injectable()
export class PageLikeRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async insert(
    pageId: string,
    userId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ) {
    return dbOrTx(this.db, trx)
      .insertInto('pageLikes')
      .values({ pageId, userId, workspaceId })
      .onConflict((oc) => oc.columns(['pageId', 'userId']).doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  async delete(pageId: string, userId: string): Promise<void> {
    await this.db
      .deleteFrom('pageLikes')
      .where('pageId', '=', pageId)
      .where('userId', '=', userId)
      .execute();
  }

  async isLiked(pageId: string, userId: string): Promise<boolean> {
    return !!(await this.db
      .selectFrom('pageLikes')
      .select('id')
      .where('pageId', '=', pageId)
      .where('userId', '=', userId)
      .executeTakeFirst());
  }
}
