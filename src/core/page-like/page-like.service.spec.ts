import { Page, User } from '@docmost/db/types/entity.types';
import { PageLikeService } from './page-like.service';

const actor = { id: 'actor', workspaceId: 'workspace' } as User;
const page = {
  id: 'page',
  workspaceId: 'workspace',
  spaceId: 'space',
  creatorId: 'owner',
} as Page;

const trx = {};
const db = { transaction: () => ({ execute: (fn: any) => fn(trx) }) };

describe('PageLikeService', () => {
  it('notifies the page creator only when a new like is recorded', async () => {
    const likes = { insert: jest.fn().mockResolvedValue({ id: 'like' }) };
    const notifications = {
      create: jest.fn().mockResolvedValue({ id: 'notice', userId: 'owner', type: 'page.liked' }),
      publish: jest.fn(),
    };
    const service = new PageLikeService(likes as any, notifications as any, db as any);

    await expect(service.like(actor, page)).resolves.toEqual({ liked: true });
    expect(notifications.create).toHaveBeenCalledWith(
      {
        userId: page.creatorId,
        workspaceId: page.workspaceId,
        type: 'page.liked',
        actorId: actor.id,
        pageId: page.id,
        spaceId: page.spaceId,
      },
      trx,
    );

    likes.insert.mockResolvedValueOnce(undefined);
    await service.like(actor, page);
    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(notifications.publish).toHaveBeenCalledTimes(1);
  });

  it('does not notify for a self-like', async () => {
    const likes = { insert: jest.fn().mockResolvedValue({ id: 'like' }) };
    const notifications = { create: jest.fn(), publish: jest.fn() };
    const service = new PageLikeService(likes as any, notifications as any, db as any);

    await service.like(actor, { ...page, creatorId: actor.id } as Page);
    expect(notifications.create).not.toHaveBeenCalled();
  });
});
