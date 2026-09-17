import { WsService } from './ws.service';

describe('Socket.IO online authorization', () => {
  it('emits a page event only to recipients with both local and current Core VIEW', async () => {
    const allowed = {
      id: 'allowed',
      data: { userId: 'user-1', workspaceId: 'workspace-1', user: { id: 'user-1' } },
      emit: jest.fn(),
      leave: jest.fn(),
    };
    const revoked = {
      id: 'revoked',
      data: { userId: 'user-2', workspaceId: 'workspace-1', user: { id: 'user-2' } },
      emit: jest.fn(),
      leave: jest.fn(),
    };
    const authorization = {
      requirePage: jest.fn().mockImplementation((_page, user) =>
        user.id === 'user-1' ? Promise.resolve() : Promise.reject(new Error('denied')),
      ),
      requireSpace: jest.fn(),
    };
    const service = new WsService(
      { getUserIdsWithPageAccess: jest.fn().mockResolvedValue(['user-1', 'user-2']) } as any,
      {} as any,
      authorization as any,
    );
    service.setServer({ in: () => ({ fetchSockets: async () => [allowed, revoked] }) } as any);

    await service.emitCommentEvent('space-1', 'page-1', { operation: 'comment' });

    expect(allowed.emit).toHaveBeenCalledWith('message', { operation: 'comment' });
    expect(revoked.emit).not.toHaveBeenCalled();
    expect(revoked.leave).toHaveBeenCalledWith('space-space-1');
  });
});
