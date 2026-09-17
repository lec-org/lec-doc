import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { AttachmentService } from '../services/attachment.service';
import { QueueJob, QueueName } from 'src/integrations/queue/constants';
import { LecResourceLifecycleService } from '../../lec-authorization/lec-resource-lifecycle.service';

@Processor(QueueName.ATTACHMENT_QUEUE)
export class AttachmentProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(AttachmentProcessor.name);
  constructor(
    private readonly attachmentService: AttachmentService,
    private readonly lifecycle: LecResourceLifecycleService,
  ) {
    super();
  }

  async process(job: Job<any, void>): Promise<void> {
    try {
      if (job.name === QueueJob.DELETE_SPACE_ATTACHMENTS) {
        await this.attachmentService.handleDeleteSpaceAttachments(job.data.id);
      }
      if (job.name === QueueJob.DELETE_USER_AVATARS) {
        await this.attachmentService.handleDeleteUserAvatars(job.data.id);
      }
      if (job.name === QueueJob.DELETE_PAGE_ATTACHMENTS) {
        await this.lifecycle.requireDeletedTree(
          job.data.workspaceId,
          job.data.rootPageId,
        );
        await this.attachmentService.handleDeletePageAttachments(
          job.data.pageId,
        );
      }
      if (job.name === QueueJob.DELETE_AI_CHAT_ATTACHMENTS) {
        await this.attachmentService.handleDeleteAiChatAttachments(
          job.data.aiChatId,
        );
      }
    } catch (err) {
      throw err;
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
