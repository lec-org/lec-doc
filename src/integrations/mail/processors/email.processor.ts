import { ForbiddenException, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { QueueName } from '../../queue/constants';
import { Job } from 'bullmq';
import { MailService } from '../mail.service';
import { MailMessage } from '../interfaces/mail.message';
import { NotificationRepo } from '@docmost/db/repos/notification/notification.repo';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { LecAuthorizationService } from '../../../core/lec-authorization/lec-authorization.service';
import { Page, User } from '@docmost/db/types/entity.types';

@Processor(QueueName.EMAIL_QUEUE)
export class EmailProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(EmailProcessor.name);
  constructor(
    private readonly mailService: MailService,
    private readonly notificationRepo: NotificationRepo,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly authorization: LecAuthorizationService,
  ) {
    super();
  }

  async process(job: Job<MailMessage, void>): Promise<void> {
    if (
      job.data.notificationId &&
      !(await this.canDeliver(job.data.notificationId))
    ) {
      return;
    }

    await this.mailService.sendEmail(job.data);

    if (job.data.notificationId) {
      try {
        await this.notificationRepo.markAsEmailed(job.data.notificationId);
      } catch (err) {
        this.logger.warn(
          `Failed to mark notification ${job.data.notificationId} as emailed`,
        );
      }
    }
  }

  private async canDeliver(notificationId: string): Promise<boolean> {
    const target = await this.db
      .selectFrom('notifications')
      .innerJoin('users', (join) =>
        join
          .onRef('users.id', '=', 'notifications.userId')
          .onRef('users.workspaceId', '=', 'notifications.workspaceId'),
      )
      .innerJoin('pages', (join) =>
        join
          .onRef('pages.id', '=', 'notifications.pageId')
          .onRef('pages.workspaceId', '=', 'notifications.workspaceId'),
      )
      .select([
        'users.id as userId',
        'users.workspaceId as workspaceId',
        'users.deactivatedAt as userDeactivatedAt',
        'users.deletedAt as userDeletedAt',
        'pages.id as pageId',
        'pages.deletedAt as pageDeletedAt',
      ])
      .where('notifications.id', '=', notificationId)
      .executeTakeFirst();
    if (!target || !target.workspaceId) return false;
    try {
      await this.authorization.requirePage(
        {
          id: target.pageId,
          workspaceId: target.workspaceId,
          deletedAt: target.pageDeletedAt,
        } as Pick<Page, 'id' | 'workspaceId' | 'deletedAt'>,
        {
          id: target.userId,
          workspaceId: target.workspaceId,
          deactivatedAt: target.userDeactivatedAt,
          deletedAt: target.userDeletedAt,
        } as User,
        'VIEW',
      );
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) return false;
      throw error;
    }
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.debug(`Processing ${job.name} job`);
  }

  @OnWorkerEvent('failed')
  onError(job: Job) {
    this.logger.error(
      `Error processing ${job.name} job. Reason: ${job.failedReason}`,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug(`Completed ${job.name} job`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }
}
