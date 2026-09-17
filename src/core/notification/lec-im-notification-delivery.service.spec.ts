import { ForbiddenException } from '@nestjs/common';
import { LecImNotificationDeliveryService } from './lec-im-notification-delivery.service';

function query(result: unknown) {
  const chain: any = {
    select: jest.fn(() => chain),
    where: jest.fn(() => chain),
    executeTakeFirst: jest.fn().mockResolvedValue(result),
  };
  return chain;
}

describe('LecImNotificationDeliveryService', () => {
  it('suppresses a revoked notification without sending sensitive content', async () => {
    const notification = {
      id: '10000000-0000-4000-8000-000000000001',
      userId: '20000000-0000-4000-8000-000000000001',
      workspaceId: '30000000-0000-4000-8000-000000000001',
      pageId: '40000000-0000-4000-8000-000000000001',
      type: 'comment.created',
    };
    const results = [
      notification,
      { id: notification.pageId, workspaceId: notification.workspaceId, deletedAt: null },
      { issuer: 'https://id.example.test', subject: 'recipient' },
    ];
    const updates: any[] = [];
    const db: any = {
      selectFrom: jest.fn(() => query(results.shift())),
      updateTable: jest.fn(() => {
        const chain: any = {
          set: jest.fn((value) => {
            updates.push(value);
            return chain;
          }),
          where: jest.fn(() => chain),
          execute: jest.fn().mockResolvedValue(undefined),
        };
        return chain;
      }),
    };
    const users = {
      findById: jest.fn().mockResolvedValue({
        id: notification.userId,
        workspaceId: notification.workspaceId,
      }),
    };
    const authorization = {
      validateCanView: jest.fn().mockRejectedValue(new ForbiddenException()),
    };
    const client = { send: jest.fn(), configured: jest.fn(() => true) };
    const service = new LecImNotificationDeliveryService(
      db,
      users as any,
      authorization as any,
      client as any,
    );

    await (service as any).process({
      notificationId: notification.id,
      attempts: 1,
    });

    expect(authorization.validateCanView).toHaveBeenCalledWith(
      expect.objectContaining({ id: notification.pageId }),
      expect.objectContaining({ id: notification.userId }),
    );
    expect(client.send).not.toHaveBeenCalled();
    expect(updates).toContainEqual(
      expect.objectContaining({
        completedAt: expect.any(Date),
        suppressedAt: expect.any(Date),
      }),
    );
    const selected = db.selectFrom.mock.results.map((result: any) => result.value.select.mock.calls.flat());
    expect(selected.flat()).not.toContain('title');
    expect(selected.flat()).not.toContain('content');
    expect(selected.flat()).not.toContain('textContent');
  });

  it('sends only a generic event after online Core VIEW allows', async () => {
    const notification = {
      id: '10000000-0000-4000-8000-000000000001',
      userId: '20000000-0000-4000-8000-000000000001',
      workspaceId: '30000000-0000-4000-8000-000000000001',
      pageId: '40000000-0000-4000-8000-000000000001',
      type: 'page.permission_granted',
    };
    const results = [
      notification,
      { id: notification.pageId, workspaceId: notification.workspaceId, deletedAt: null },
      { issuer: 'https://id.example.test', subject: 'recipient' },
    ];
    const db: any = {
      selectFrom: jest.fn(() => query(results.shift())),
      updateTable: jest.fn(() => {
        const chain: any = {
          set: jest.fn(() => chain),
          where: jest.fn(() => chain),
          execute: jest.fn().mockResolvedValue(undefined),
        };
        return chain;
      }),
    };
    const users = {
      findById: jest.fn().mockResolvedValue({
        id: notification.userId,
        workspaceId: notification.workspaceId,
      }),
    };
    const authorization = { validateCanView: jest.fn().mockResolvedValue(undefined) };
    const client = { send: jest.fn().mockResolvedValue(undefined), configured: jest.fn(() => true) };
    const service = new LecImNotificationDeliveryService(db, users as any, authorization as any, client as any);

    await (service as any).process({ notificationId: notification.id, attempts: 1 });

    expect(client.send).toHaveBeenCalledWith({
      event_id: notification.id,
      workspace_id: notification.workspaceId,
      resource_id: notification.pageId,
      recipient: { issuer: 'https://id.example.test', subject: 'recipient' },
      event_type: 'PAGE_PERMISSION_GRANTED',
      text: '你获得了一篇云文档的访问权限',
    });
  });
});
