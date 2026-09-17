import { Hocuspocus } from '@hocuspocus/server';
import { CollaborationHandler } from './collaboration.handler';

const page = {
  id: '10000000-0000-4000-8000-000000000001',
  workspaceId: '10000000-0000-4000-8000-000000000002',
  spaceId: '10000000-0000-4000-8000-000000000003',
  deletedAt: null,
};
const user = { id: 'user-1', workspaceId: page.workspaceId } as any;

describe('Server-internal collaboration writes', () => {
  it('authorizes a DirectConnection explicitly and carries the checked capability into persistence', async () => {
    const authorization = { requirePage: jest.fn().mockResolvedValue(undefined) };
    const onLoadDocument = jest.fn();
    const onChange = jest.fn();
    const onStoreDocument = jest.fn();
    const hocuspocus = new Hocuspocus({
      extensions: [{ onLoadDocument, onChange, onStoreDocument }],
    });
    const handler = new CollaborationHandler(
      authorization as any,
      { findById: jest.fn().mockResolvedValue(page) } as any,
    );

    await handler
      .getHandlers(hocuspocus)
      .updatePageContent(`page.${page.id}`, {
        prosemirrorJson: {
          type: 'doc',
          content: [{ type: 'paragraph' }],
        },
        operation: 'replace',
        user,
      });

    expect(authorization.requirePage).toHaveBeenCalledWith(page, user, 'EDIT');
    expect(onLoadDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          user,
          pageId: page.id,
          workspaceId: page.workspaceId,
          writeCapability: 'EDIT',
        }),
      }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          user,
          pageId: page.id,
          writeCapability: 'EDIT',
        }),
        transactionOrigin: expect.objectContaining({ source: 'local' }),
      }),
    );
    expect(onStoreDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        lastContext: expect.objectContaining({
          user,
          pageId: page.id,
          writeCapability: 'EDIT',
        }),
      }),
    );
    expect(hocuspocus.getDocumentsCount()).toBe(0);
  });

  it.each([
    [
      'updatePageContent',
      'EDIT',
      {
        prosemirrorJson: { type: 'doc', content: [] },
        operation: 'replace',
        user,
      },
    ],
    [
      'setCommentMark',
      'COMMENT',
      {
        yjsSelection: {},
        commentId: 'comment-1',
        resolved: false,
        user,
      },
    ],
    [
      'resolveCommentMark',
      'COMMENT',
      { commentId: 'comment-1', resolved: true, user },
    ],
  ] as const)(
    'checks Core before %s opens a DirectConnection and never mutates on deny',
    async (handlerName, capability, payload) => {
      const authorization = {
        requirePage: jest.fn().mockRejectedValue(new Error('Core denied')),
      };
      const hocuspocus = new Hocuspocus();
      const open = jest.spyOn(hocuspocus, 'openDirectConnection');
      const handler = new CollaborationHandler(
        authorization as any,
        { findById: jest.fn().mockResolvedValue(page) } as any,
      );

      await expect(
        (handler.getHandlers(hocuspocus)[handlerName] as any)(
          `page.${page.id}`,
          payload,
        ),
      ).rejects.toThrow('Core denied');

      expect(authorization.requirePage).toHaveBeenCalledWith(
        page,
        user,
        capability,
      );
      expect(open).not.toHaveBeenCalled();
      expect(hocuspocus.getDocumentsCount()).toBe(0);
    },
  );
});
