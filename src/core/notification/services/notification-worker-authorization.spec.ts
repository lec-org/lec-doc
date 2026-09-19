import { ServiceUnavailableException } from '@nestjs/common';
import { CommentNotificationService } from './comment.notification';
import { PageNotificationService } from './page.notification';
import { VerificationNotificationService } from './verification.notification';

const ids = {
  user: 'e2279aa5-b0c3-482e-816a-e0dd2ade7c37',
  actor: 'b0494b41-8dc1-4d64-ac33-11ae2ffce28f',
  page: 'fe96e188-64d1-4ab0-9e54-ea3eff745572',
  space: '74c7066e-a1b5-49ca-8087-6f73e30cab79',
  workspace: '1c312fef-c48f-4d57-bdd6-e5694315d702',
  comment: '9d3e598b-23d4-43ce-a8fb-c5f99e8579bf',
  verification: '31bd1544-2b8e-4b38-8aec-b838ff7453b8',
};

function sideEffects() {
  return {
    create: jest.fn(),
    queueEmail: jest.fn(),
    filterRecipientsWithCoreView: jest.fn(),
  };
}

describe('notification workers authorize before sensitive context', () => {
  it.each([
    ['denied', Promise.resolve(new Set<string>())],
    ['Core outage', Promise.reject(new ServiceUnavailableException())],
  ])(
    'page worker: %s reads no page title and writes nothing',
    async (_, result) => {
      const notification = sideEffects();
      notification.filterRecipientsWithCoreView.mockReturnValue(result);
      const db = { selectFrom: jest.fn() };
      const local = {
        getUserIdsWithSpaceAccess: jest.fn(),
        getUserIdsWithPageAccess: jest.fn(),
      };
      const service = new PageNotificationService(
        db as any,
        notification as any,
        {} as any,
        local as any,
        local as any,
        {} as any,
        {} as any,
        {} as any,
      );
      const run = service.processPageMention(
        {
          userMentions: [
            { userId: ids.user, creatorId: ids.actor, mentionId: 'mention' },
          ],
          oldMentionedUserIds: [],
          pageId: ids.page,
          spaceId: ids.space,
          workspaceId: ids.workspace,
        },
        'https://docs.example.test',
      );

      if (_ === 'Core outage')
        await expect(run).rejects.toBeInstanceOf(ServiceUnavailableException);
      else await expect(run).resolves.toBeUndefined();
      expect(db.selectFrom).not.toHaveBeenCalled();
      expect(local.getUserIdsWithSpaceAccess).not.toHaveBeenCalled();
      expect(notification.create).not.toHaveBeenCalled();
      expect(notification.queueEmail).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['denied', Promise.resolve(new Set<string>())],
    ['Core outage', Promise.reject(new ServiceUnavailableException())],
  ])(
    'comment worker: %s reads no title/comment context and writes nothing',
    async (_, result) => {
      const notification = sideEffects();
      notification.filterRecipientsWithCoreView.mockReturnValue(result);
      const db = { selectFrom: jest.fn() };
      const local = {
        getUserIdsWithSpaceAccess: jest.fn(),
        getUserIdsWithPageAccess: jest.fn(),
      };
      const service = new CommentNotificationService(
        db as any,
        notification as any,
        { getPageWatcherIds: jest.fn() } as any,
      );
      const run = service.processComment(
        {
          commentId: ids.comment,
          pageId: ids.page,
          spaceId: ids.space,
          workspaceId: ids.workspace,
          actorId: ids.actor,
          mentionedUserIds: [ids.user],
          notifyWatchers: false,
        },
        'https://docs.example.test',
      );

      if (_ === 'Core outage')
        await expect(run).rejects.toBeInstanceOf(ServiceUnavailableException);
      else await expect(run).resolves.toBeUndefined();
      expect(db.selectFrom).not.toHaveBeenCalled();
      expect(local.getUserIdsWithSpaceAccess).not.toHaveBeenCalled();
      expect(notification.create).not.toHaveBeenCalled();
      expect(notification.queueEmail).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['denied', Promise.resolve(new Set<string>())],
    ['Core outage', Promise.reject(new ServiceUnavailableException())],
  ])(
    'verification worker: %s reads no page context and writes nothing',
    async (_, result) => {
      const notification = sideEffects();
      notification.filterRecipientsWithCoreView.mockReturnValue(result);
      const chain: any = {
        leftJoin: jest.fn(() => chain),
        select: jest.fn(() => chain),
        where: jest.fn(() => chain),
        groupBy: jest.fn(() => chain),
        execute: jest.fn().mockResolvedValue([
          {
            id: ids.verification,
            type: 'expiring',
            expiresAt: new Date(Date.now() + 60_000),
            pageId: ids.page,
            spaceId: ids.space,
            workspaceId: ids.workspace,
            verifierIds: [ids.user],
          },
        ]),
      };
      const db = { selectFrom: jest.fn(() => chain) };
      const local = {
        getUserIdsWithSpaceAccess: jest.fn(),
        getUserIdsWithPageAccess: jest.fn(),
      };
      const service = new VerificationNotificationService(
        db as any,
        notification as any,
        local as any,
        local as any,
      );
      const run = service.processVerificationExpiring(
        { verificationId: ids.verification },
        'https://docs.example.test',
      );

      if (_ === 'Core outage')
        await expect(run).rejects.toBeInstanceOf(ServiceUnavailableException);
      else await expect(run).resolves.toBeUndefined();
      expect(db.selectFrom).toHaveBeenCalledTimes(1);
      expect(local.getUserIdsWithSpaceAccess).not.toHaveBeenCalled();
      expect(notification.create).not.toHaveBeenCalled();
      expect(notification.queueEmail).not.toHaveBeenCalled();
    },
  );
});
