import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx } from '@docmost/db/utils';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { LecResourceLifecycleService } from '../../lec-authorization/lec-resource-lifecycle.service';

@Injectable()
export class PageMaintenanceService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.ATTACHMENT_QUEUE)
    private readonly attachmentQueue: Queue,
    private readonly lifecycle: LecResourceLifecycleService,
  ) {}

  async nextPagePosition(
    spaceId: string,
    parentPageId?: string,
    trx?: KyselyTransaction,
  ) {
    let query = dbOrTx(this.db, trx)
      .selectFrom('pages')
      .select('position')
      .where('spaceId', '=', spaceId)
      .where('deletedAt', 'is', null)
      .orderBy('position', (ob) => ob.collate('C').desc())
      .limit(1);

    query = parentPageId
      ? query.where('parentPageId', '=', parentPageId)
      : query.where('parentPageId', 'is', null);
    const lastPage = await query.executeTakeFirst();
    return generateJitteredKeyBetween(lastPage?.position ?? null, null);
  }

  async forceDelete(pageId: string, workspaceId: string): Promise<void> {
    const descendants = await this.db
      .withRecursive('page_descendants', (db) =>
        db
          .selectFrom('pages')
          .select('id')
          .where('id', '=', pageId)
          .unionAll((exp) =>
            exp
              .selectFrom('pages as p')
              .select('p.id')
              .innerJoin('page_descendants as pd', 'pd.id', 'p.parentPageId'),
          ),
      )
      .selectFrom('page_descendants')
      .selectAll()
      .execute();
    const pageIds = descendants.map(({ id }) => id);
    if (pageIds.length === 0) return;

    for (const id of pageIds) {
      await this.attachmentQueue.add(
        QueueJob.DELETE_PAGE_ATTACHMENTS,
        { pageId: id, rootPageId: pageId, workspaceId },
        {
          jobId: `delete-page-attachments-${id}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
        },
      );
    }

    await this.lifecycle.requireDeletedTree(
      workspaceId,
      pageId,
      pageIds.map((id) => ({ id })),
    );
    await this.db.deleteFrom('pages').where('id', 'in', pageIds).execute();
  }
}
