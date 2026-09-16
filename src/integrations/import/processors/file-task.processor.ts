import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from 'src/integrations/queue/constants';
import { FileImportTaskService } from '../services/file-import-task.service';
import { FileTaskStatus } from '../utils/file.utils';
import { StorageService } from '../../storage/storage.service';

@Processor(QueueName.FILE_TASK_QUEUE)
export class FileTaskProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(FileTaskProcessor.name);

  constructor(
    private readonly fileTaskService: FileImportTaskService,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<any, void>): Promise<void> {
    try {
      switch (job.name) {
        case QueueJob.IMPORT_TASK:
          await this.fileTaskService.processZIpImport(job.data.fileTaskId);
          break;
      }
    } catch (err) {
      this.logger.error('File task failed', err);
      throw err;
    }
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.debug(`Processing ${job.name} job`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job) {
    const fileTaskId = job.data?.fileTaskId;
    this.logger.error(
      fileTaskId
        ? `Error processing ${job.name} job. File Task ID: ${fileTaskId}. Reason: ${job.failedReason}`
        : `Error processing ${job.name} job. Reason: ${job.failedReason}`,
    );

    if (job.name === QueueJob.IMPORT_TASK) {
      await this.handleFailedImportJob(job);
    }
  }

  @OnWorkerEvent('completed')
  async onCompleted(job: Job) {
    const fileTaskId = job.data?.fileTaskId;
    this.logger.log(
      fileTaskId
        ? `Completed ${job.name} job for File task ID ${fileTaskId}`
        : `Completed ${job.name} job`,
    );

    if (job.name === QueueJob.IMPORT_TASK) {
      try {
        const fileTask = await this.fileTaskService.getFileTask(
          job.data.fileTaskId,
        );
        if (fileTask) {
          await this.storageService.delete(fileTask.filePath);
          this.logger.debug(`Deleted imported zip file: ${fileTask.filePath}`);
        }
      } catch (err) {
        this.logger.error(`Failed to delete imported zip file:`, err);
      }
    }
  }

  private async handleFailedImportJob(job: Job) {
    try {
      const fileTaskId = job.data.fileTaskId;
      const reason = job.failedReason || 'Unknown error';

      await this.fileTaskService.updateTaskStatus(
        fileTaskId,
        FileTaskStatus.Failed,
        reason,
      );

      const fileTask = await this.fileTaskService.getFileTask(fileTaskId);
      if (fileTask) {
        await this.storageService.delete(fileTask.filePath);
      }
    } catch (err) {
      this.logger.error(err);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }
}
