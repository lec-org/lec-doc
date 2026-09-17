import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { QueueJob } from '../../integrations/queue/constants';
import { HistoryProcessor } from './history.processor';

const page = {
  id: 'page-1',
  workspaceId: 'workspace-1',
  spaceId: 'space-1',
  deletedAt: null,
  content: { type: 'doc', content: [{ type: 'paragraph' }] },
};
const user = { id: 'user-1', workspaceId: page.workspaceId };
const job = {
  name: QueueJob.PAGE_HISTORY,
  data: { pageId: page.id, actorId: user.id },
};

function processor(requirePage: jest.Mock, currentUser: any = user) {
  const history = {
    findPageLastHistory: jest.fn(),
    saveHistory: jest.fn(),
  };
  const pages = {
    findAuthorizationSubject: jest.fn().mockResolvedValue({
      id: page.id,
      workspaceId: page.workspaceId,
      deletedAt: null,
    }),
    findById: jest.fn().mockResolvedValue(page),
  };
  const collabHistory = {
    clearContributors: jest.fn(),
    popContributors: jest.fn(),
    addContributors: jest.fn(),
  };
  const watchers = { addPageWatchers: jest.fn() };
  const notificationQueue = { add: jest.fn() };
  const generalQueue = { add: jest.fn() };
  const users = { findById: jest.fn().mockResolvedValue(currentUser) };
  const service = new HistoryProcessor(
    history as any,
    pages as any,
    collabHistory as any,
    watchers as any,
    notificationQueue as any,
    generalQueue as any,
    users as any,
    { requirePage } as any,
  );
  return {
    service,
    history,
    collabHistory,
    watchers,
    notificationQueue,
    generalQueue,
    pages,
  };
}

describe('Page history execution-time authorization fence', () => {
  it('suppresses history after the initiating actor is disabled or loses Core EDIT', async () => {
    const {
      service,
      history,
      collabHistory,
      watchers,
      generalQueue,
      pages,
    } = processor(jest.fn().mockRejectedValue(new ForbiddenException()));

    await expect(service.process(job as any)).resolves.toBeUndefined();

    expect(pages.findById).not.toHaveBeenCalled();
    expect(history.findPageLastHistory).not.toHaveBeenCalled();
    expect(history.saveHistory).not.toHaveBeenCalled();
    expect(collabHistory.popContributors).not.toHaveBeenCalled();
    expect(watchers.addPageWatchers).not.toHaveBeenCalled();
    expect(generalQueue.add).not.toHaveBeenCalled();
  });

  it('suppresses legacy history jobs without an initiating actor', async () => {
    const { service, history, collabHistory, pages } = processor(jest.fn());

    await expect(
      service.process({
        ...job,
        data: { pageId: page.id },
      } as any),
    ).resolves.toBeUndefined();

    expect(pages.findAuthorizationSubject).not.toHaveBeenCalled();
    expect(history.findPageLastHistory).not.toHaveBeenCalled();
    expect(collabHistory.popContributors).not.toHaveBeenCalled();
  });

  it('suppresses history when the initiating actor was disabled after enqueue', async () => {
    const requirePage = jest.fn().mockRejectedValue(new ForbiddenException());
    const { service, history, collabHistory } = processor(requirePage, {
      ...user,
      deactivatedAt: new Date(),
    });

    await expect(service.process(job as any)).resolves.toBeUndefined();

    expect(requirePage).toHaveBeenCalledWith(
      expect.objectContaining({ id: page.id }),
      expect.objectContaining({ deactivatedAt: expect.any(Date) }),
      'EDIT',
    );
    expect(history.findPageLastHistory).not.toHaveBeenCalled();
    expect(collabHistory.popContributors).not.toHaveBeenCalled();
  });

  it('throws when Core is unavailable so BullMQ retries with no side effects', async () => {
    const outage = new ServiceUnavailableException();
    const { service, history, collabHistory, watchers, generalQueue } = processor(
      jest.fn().mockRejectedValue(outage),
    );

    await expect(service.process(job as any)).rejects.toBe(outage);

    expect(history.findPageLastHistory).not.toHaveBeenCalled();
    expect(history.saveHistory).not.toHaveBeenCalled();
    expect(collabHistory.popContributors).not.toHaveBeenCalled();
    expect(watchers.addPageWatchers).not.toHaveBeenCalled();
    expect(generalQueue.add).not.toHaveBeenCalled();
  });
});
