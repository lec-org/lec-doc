jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (value: string) => value,
}));
jest.mock('p-limit', () => ({
  __esModule: true,
  default: () => (work: () => unknown) => work(),
}));

import { QueueJob } from '../../queue/constants';
import { FileTaskProcessor } from './file-task.processor';

function processor() {
  const tasks = {
    updateTaskStatus: jest.fn(),
    getFileTask: jest.fn(),
  };
  const storage = { delete: jest.fn() };
  return {
    processor: new FileTaskProcessor(tasks as any, storage as any),
    tasks,
    storage,
  };
}

describe('ZIP import retry cleanup', () => {
  it('keeps the archive and processing status while BullMQ will retry', async () => {
    const fixture = processor();
    await fixture.processor.onFailed({
      name: QueueJob.IMPORT_TASK,
      data: { fileTaskId: 'task' },
      failedReason: 'Core unavailable',
      attemptsMade: 1,
      opts: { attempts: 3 },
    } as any);

    expect(fixture.tasks.updateTaskStatus).not.toHaveBeenCalled();
    expect(fixture.storage.delete).not.toHaveBeenCalled();
  });

  it('marks failed and removes the archive only after the final attempt', async () => {
    const fixture = processor();
    fixture.tasks.getFileTask.mockResolvedValue({
      filePath: 'imports/task.zip',
    });
    await fixture.processor.onFailed({
      name: QueueJob.IMPORT_TASK,
      data: { fileTaskId: 'task' },
      failedReason: 'Core unavailable',
      attemptsMade: 3,
      opts: { attempts: 3 },
    } as any);

    expect(fixture.tasks.updateTaskStatus).toHaveBeenCalledWith(
      'task',
      'failed',
      'Core unavailable',
    );
    expect(fixture.storage.delete).toHaveBeenCalledWith('imports/task.zip');
  });
});
