import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { QueueJob } from '../constants';
import { GeneralQueueProcessor } from './general-queue.processor';

const page = {
  id: 'page-1',
  workspaceId: 'workspace-1',
  spaceId: 'space-1',
  deletedAt: null,
};
const user = { id: 'user-1', workspaceId: page.workspaceId };

function processor(requirePage: jest.Mock, currentUser: any = user) {
  const db = { transaction: jest.fn() };
  const backlinkRepo = { insertBacklink: jest.fn() };
  const watcherRepo = { insertMany: jest.fn() };
  const pages = {
    findAuthorizationSubject: jest.fn().mockResolvedValue(page),
  };
  const users = { findById: jest.fn().mockResolvedValue(currentUser) };
  const service = new GeneralQueueProcessor(
    db as any,
    backlinkRepo as any,
    watcherRepo as any,
    pages as any,
    users as any,
    { requirePage } as any,
  );
  return { service, db, backlinkRepo, watcherRepo, pages, users };
}

describe('General queue execution-time authorization fence', () => {
  const watcherJob = {
    name: QueueJob.ADD_PAGE_WATCHERS,
    data: {
      actorId: user.id,
      userIds: [user.id],
      pageId: page.id,
      spaceId: page.spaceId,
      workspaceId: page.workspaceId,
    },
  };

  const backlinkJob = {
    name: QueueJob.PAGE_BACKLINKS,
    data: {
      actorId: user.id,
      pageId: page.id,
      workspaceId: page.workspaceId,
      mentions: [],
    },
  };

  it.each([watcherJob, backlinkJob])(
    'suppresses $name after Core EDIT is revoked',
    async (job) => {
      const { service, db, backlinkRepo, watcherRepo } = processor(
        jest.fn().mockRejectedValue(new ForbiddenException()),
      );

      await expect(service.process(job as any)).resolves.toBeUndefined();

      expect(watcherRepo.insertMany).not.toHaveBeenCalled();
      expect(backlinkRepo.insertBacklink).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    },
  );

  it.each([watcherJob, backlinkJob])(
    'suppresses legacy $name jobs without an initiating actor',
    async (job) => {
      const data = { ...job.data } as Record<string, unknown>;
      delete data.actorId;
      const requirePage = jest.fn();
      const { service, db, watcherRepo } = processor(requirePage);

      await expect(service.process({ ...job, data } as any)).resolves.toBeUndefined();

      expect(requirePage).not.toHaveBeenCalled();
      expect(watcherRepo.insertMany).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    },
  );

  it('suppresses a watcher insert when the initiating actor was disabled after enqueue', async () => {
    const requirePage = jest.fn().mockRejectedValue(new ForbiddenException());
    const { service, watcherRepo } = processor(requirePage, {
      ...user,
      deactivatedAt: new Date(),
    });

    await expect(service.process(watcherJob as any)).resolves.toBeUndefined();

    expect(requirePage).toHaveBeenCalledWith(
      page,
      expect.objectContaining({ deactivatedAt: expect.any(Date) }),
      'EDIT',
    );
    expect(watcherRepo.insertMany).not.toHaveBeenCalled();
  });

  it.each([watcherJob, backlinkJob])(
    'throws $name when Core is unavailable so BullMQ retries it',
    async (job) => {
      const outage = new ServiceUnavailableException();
      const { service, db, backlinkRepo, watcherRepo } = processor(
        jest.fn().mockRejectedValue(outage),
      );

      await expect(service.process(job as any)).rejects.toBe(outage);

      expect(watcherRepo.insertMany).not.toHaveBeenCalled();
      expect(backlinkRepo.insertBacklink).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    },
  );
});
