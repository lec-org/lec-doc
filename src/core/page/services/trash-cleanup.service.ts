import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PageMaintenanceService } from './page-maintenance.service';

const DEFAULT_RETENTION_DAYS = 30;

@Injectable()
export class TrashCleanupService {
  private readonly logger = new Logger(TrashCleanupService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageMaintenance: PageMaintenanceService,
  ) {}

  @Interval('trash-cleanup', 24 * 60 * 60 * 1000) // every 24 hours
  async cleanupOldTrash() {
    try {
      this.logger.debug('Starting trash cleanup job');

      const workspaces = await this.db
        .selectFrom('workspaces')
        .select(['id', 'trashRetentionDays'])
        .where('deletedAt', 'is', null)
        .execute();

      let totalCleaned = 0;

      for (const workspace of workspaces) {
        const retentionDays =
          workspace.trashRetentionDays ?? DEFAULT_RETENTION_DAYS;

        const retentionDate = new Date();
        retentionDate.setDate(retentionDate.getDate() - retentionDays);

        const oldDeletedPages = await this.db
          .selectFrom('pages')
          .select(['id', 'workspaceId'])
          .where('workspaceId', '=', workspace.id)
          .where('deletedAt', '<', retentionDate)
          .execute();

        for (const page of oldDeletedPages) {
          try {
            await this.pageMaintenance.forceDelete(page.id, page.workspaceId);
            totalCleaned++;
          } catch (error) {
            this.logger.error(
              `Failed to cleanup page ${page.id}: ${error instanceof Error ? error.message : 'Unknown error'}`,
              error instanceof Error ? error.stack : undefined,
            );
          }
        }
      }

      this.logger.debug(
        totalCleaned > 0
          ? `Trash cleanup completed: ${totalCleaned} pages cleaned`
          : 'No old trash items to clean up',
      );
    } catch (error) {
      this.logger.error(
        'Trash cleanup job failed',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
