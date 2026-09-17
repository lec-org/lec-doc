import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { NotificationService } from './notification.service';

const notification = {
  id: 'notice',
  userId: 'recipient',
  workspaceId: 'workspace',
  pageId: 'page',
  type: 'comment.created',
};
const recipient = {
  id: 'recipient',
  workspaceId: 'workspace',
  email: 'recipient@example.test',
  deletedAt: null,
  deactivatedAt: null,
  settings: null,
};

function pageQuery(page: unknown) {
  const chain: any = {
    select: jest.fn(() => chain),
    where: jest.fn(() => chain),
    executeTakeFirst: jest.fn().mockResolvedValue(page),
  };
  return chain;
}

function service(access: jest.Mock, mail = { sendToQueue: jest.fn() }) {
  const repo = {
    findById: jest.fn().mockResolvedValue(notification),
    insert: jest.fn().mockResolvedValue(notification),
  };
  const users = { findById: jest.fn().mockResolvedValue(recipient) };
  const db = {
    selectFrom: jest.fn(() =>
      pageQuery({
        id: 'page',
        workspaceId: 'workspace',
        spaceId: 'space',
        deletedAt: null,
      }),
    ),
  };
  return {
    notificationService: new NotificationService(
      repo as any,
      {} as any,
      { server: { to: () => ({ emit: jest.fn() }) } } as any,
      mail as any,
      db as any,
      {} as any,
      users as any,
      { validateCanView: access } as any,
    ),
    repo,
    mail,
  };
}

describe('notification side-effect authorization', () => {
  it('does not persist a page notification after explicit revocation', async () => {
    const { notificationService, repo } = service(
      jest.fn().mockRejectedValue(new ForbiddenException()),
    );

    await expect(notificationService.create(notification as any)).resolves.toBeNull();
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('retries instead of sending email when Core is unavailable', async () => {
    const { notificationService, mail } = service(
      jest.fn().mockRejectedValue(new ServiceUnavailableException()),
    );

    await expect(
      notificationService.queueEmail(
        notification.userId,
        notification.id,
        'sensitive subject',
        {},
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(mail.sendToQueue).not.toHaveBeenCalled();
  });
});
