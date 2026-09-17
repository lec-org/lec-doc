import { User } from '@docmost/db/types/entity.types';
import { NotificationService } from './notification.service';

const user = { id: 'user', workspaceId: 'workspace' } as User;

describe('NotificationService authorization', () => {
  it('authorizes page ids before loading notification metadata and fills the page', async () => {
    const candidates = [
      { id: 'n1', pageId: 'denied', workspaceId: 'workspace', $cursor: 'c1' },
      { id: 'n2', pageId: 'allowed', workspaceId: 'workspace', $cursor: 'c2' },
      { id: 'n3', pageId: null, workspaceId: 'workspace', $cursor: 'c3' },
    ];
    const repo = {
      findCandidates: jest.fn().mockResolvedValue({
        items: candidates,
        meta: { nextCursor: null },
      }),
      findContentByIds: jest.fn().mockResolvedValue([
        { id: 'n2', page: { title: 'allowed title' } },
        { id: 'n3', page: null },
      ]),
    };
    const core = {
      filterPages: jest
        .fn()
        .mockResolvedValue([{ id: 'allowed', workspaceId: 'workspace' }]),
    };
    const local = {
      filterAccessiblePageIds: jest.fn().mockResolvedValue(['allowed']),
    };
    const service = new NotificationService(
      repo as any,
      local as any,
      {} as any,
      {} as any,
      {} as any,
      core as any,
      {} as any,
      {} as any,
    );

    const result = await service.findByUserId(user, { limit: 2 } as any);

    expect(core.filterPages).toHaveBeenCalledWith(
      [
        { id: 'denied', workspaceId: 'workspace' },
        { id: 'allowed', workspaceId: 'workspace' },
      ],
      user,
    );
    expect(repo.findContentByIds).toHaveBeenCalledWith(['n2', 'n3']);
    expect(result.items.map((item: any) => item.id)).toEqual(['n2', 'n3']);
  });

  it('counts only unread notifications whose pages remain authorized', async () => {
    const repo = {
      findCandidates: jest
        .fn()
        .mockResolvedValueOnce({
          items: [
            {
              id: 'n1',
              pageId: 'allowed',
              workspaceId: 'workspace',
              $cursor: 'c1',
            },
            {
              id: 'n2',
              pageId: 'denied',
              workspaceId: 'workspace',
              $cursor: 'c2',
            },
          ],
          meta: { nextCursor: 'next' },
        })
        .mockResolvedValueOnce({
          items: [
            { id: 'n3', pageId: null, workspaceId: 'workspace', $cursor: 'c3' },
          ],
          meta: { nextCursor: null },
        }),
    };
    const core = {
      filterPages: jest
        .fn()
        .mockImplementation(async (pages: any[]) =>
          pages.filter((page) => page.id === 'allowed'),
        ),
    };
    const local = {
      filterAccessiblePageIds: jest.fn().mockResolvedValue(['allowed']),
    };
    const service = new NotificationService(
      repo as any,
      local as any,
      {} as any,
      {} as any,
      {} as any,
      core as any,
      {} as any,
      {} as any,
    );

    await expect(service.getUnreadCount(user)).resolves.toBe(2);
    expect(repo.findCandidates).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['selected', ['n1', 'n2', 'n3']],
    ['all', undefined],
  ])(
    'marks only Core VIEW-authorized %s notification candidates as read',
    async (_scope, notificationIds) => {
      const repo = {
        findReadCandidates: jest.fn().mockResolvedValue([
          { id: 'n1', pageId: 'denied', workspaceId: 'workspace' },
          { id: 'n2', pageId: 'allowed', workspaceId: 'workspace' },
          { id: 'n3', pageId: null, workspaceId: 'workspace' },
        ]),
        markMultipleAsRead: jest.fn(),
      };
      const core = {
        filterPages: jest
          .fn()
          .mockResolvedValue([{ id: 'allowed', workspaceId: 'workspace' }]),
      };
      const local = {
        filterAccessiblePageIds: jest
          .fn()
          .mockResolvedValue(['allowed', 'denied']),
      };
      const service = new NotificationService(
        repo as any,
        local as any,
        {} as any,
        {} as any,
        {} as any,
        core as any,
        {} as any,
        {} as any,
      );

      if (notificationIds) {
        await service.markMultipleAsRead(notificationIds, user as any);
      } else {
        await service.markAllAsRead(user as any);
      }

      expect(repo.findReadCandidates).toHaveBeenCalledWith(
        user.id,
        notificationIds,
      );
      expect(core.filterPages).toHaveBeenCalledWith(
        [
          { id: 'denied', workspaceId: 'workspace' },
          { id: 'allowed', workspaceId: 'workspace' },
        ],
        user,
      );
      expect(repo.markMultipleAsRead).toHaveBeenCalledWith(
        ['n2', 'n3'],
        user.id,
      );
    },
  );

  it.each([
    ['selected', ['n1']],
    ['all', undefined],
  ])(
    'updates no %s notifications when Core is unavailable',
    async (_scope, notificationIds) => {
      const repo = {
        findReadCandidates: jest
          .fn()
          .mockResolvedValue([
            { id: 'n1', pageId: 'page', workspaceId: 'workspace' },
          ]),
        markMultipleAsRead: jest.fn(),
      };
      const coreError = new Error('Core unavailable');
      const core = { filterPages: jest.fn().mockRejectedValue(coreError) };
      const local = { filterAccessiblePageIds: jest.fn() };
      const service = new NotificationService(
        repo as any,
        local as any,
        {} as any,
        {} as any,
        {} as any,
        core as any,
        {} as any,
        {} as any,
      );

      const action = notificationIds
        ? service.markMultipleAsRead(notificationIds, user as any)
        : service.markAllAsRead(user as any);

      await expect(action).rejects.toBe(coreError);
      expect(local.filterAccessiblePageIds).not.toHaveBeenCalled();
      expect(repo.markMultipleAsRead).not.toHaveBeenCalled();
    },
  );
});
