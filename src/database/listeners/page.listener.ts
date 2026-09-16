import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventName } from '../../common/events/event.contants';
import { InjectQueue } from '@nestjs/bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { Queue } from 'bullmq';

export class PageEvent {
  pageIds: string[];
  workspaceId: string;
  operationId?: string;
}

@Injectable()
export class PageListener {
  private readonly logger = new Logger(PageListener.name);

  constructor(
    @InjectQueue(QueueName.AI_QUEUE) private aiQueue: Queue,
  ) {}

  @OnEvent(EventName.PAGE_CREATED)
  async handlePageCreated(event: PageEvent) {
    const { pageIds, workspaceId, operationId } = event;
    await this.aiQueue.add(
      QueueJob.PAGE_CREATED,
      { pageIds, workspaceId },
      operationId
        ? {
            jobId: `${operationId}-created`,
            removeOnComplete: { age: 86_400, count: 10_000 },
          }
        : {},
    );
  }

  @OnEvent(EventName.PAGE_DELETED)
  async handlePageDeleted(event: PageEvent) {
    const { pageIds, workspaceId } = event;
    await this.aiQueue.add(QueueJob.PAGE_DELETED, { pageIds, workspaceId });
  }

  @OnEvent(EventName.PAGE_SOFT_DELETED)
  async handlePageSoftDeleted(event: PageEvent) {
    const { pageIds, workspaceId, operationId } = event;

    await this.aiQueue.add(
      QueueJob.PAGE_SOFT_DELETED,
      { pageIds, workspaceId },
      operationId
        ? {
            jobId: `${operationId}-soft-deleted`,
            removeOnComplete: { age: 86_400, count: 10_000 },
          }
        : {},
    );
  }

  @OnEvent(EventName.PAGE_RESTORED)
  async handlePageRestored(event: PageEvent) {
    const { pageIds, workspaceId, operationId } = event;
    await this.aiQueue.add(
      QueueJob.PAGE_RESTORED,
      { pageIds, workspaceId },
      operationId
        ? {
            jobId: `${operationId}-restored`,
            removeOnComplete: { age: 86_400, count: 10_000 },
          }
        : {},
    );
  }
}
