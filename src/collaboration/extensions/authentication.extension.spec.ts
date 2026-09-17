import { UnauthorizedException } from '@nestjs/common';
import { AuthenticationExtension } from './authentication.extension';

describe('Collaboration online Core authorization', () => {
  const page = {
    id: '10000000-0000-4000-8000-000000000001',
    workspaceId: '10000000-0000-4000-8000-000000000002',
    spaceId: '10000000-0000-4000-8000-000000000003',
    deletedAt: null,
  };
  const user = { id: 'user-1', workspaceId: page.workspaceId } as any;
  const token = {
    verifyJwt: jest.fn().mockResolvedValue({
      sub: user.id,
      workspaceId: page.workspaceId,
    }),
  };
  const users = { findById: jest.fn().mockResolvedValue(user) };
  const pages = { findById: jest.fn().mockResolvedValue(page) };
  const members = {
    getUserSpaceRoles: jest.fn().mockResolvedValue([{ role: 'admin' }]),
  };
  const permissions = {
    canUserEditPage: jest.fn().mockResolvedValue({
      hasAnyRestriction: false,
      canAccess: true,
      canEdit: true,
    }),
  };

  it('requires online VIEW and EDIT before authenticating a writable socket', async () => {
    const authorization = {
      page: jest.fn().mockResolvedValue([
        { capability: 'VIEW', allowed: true },
        { capability: 'EDIT', allowed: false },
      ]),
      requirePage: jest.fn(),
    };
    const extension = new AuthenticationExtension(
      token as any,
      users as any,
      pages as any,
      members as any,
      permissions as any,
      authorization as any,
    );
    const data = {
      documentName: `page.${page.id}`,
      token: 'collab-token',
      connectionConfig: { readOnly: false },
    } as any;
    await expect(extension.onAuthenticate(data)).resolves.toMatchObject({
      user,
      pageId: page.id,
      workspaceId: page.workspaceId,
      spaceId: page.spaceId,
    });
    expect(data.connectionConfig.readOnly).toBe(true);
    expect(authorization.page).toHaveBeenCalledWith(page, user, [
      'VIEW',
      'EDIT',
    ]);
  });

  it('rechecks Core on sync, updates, awareness and persistence', async () => {
    const authorization = {
      page: jest.fn(),
      requirePage: jest.fn().mockResolvedValue(undefined),
    };
    const extension = new AuthenticationExtension(
      token as any,
      users as any,
      pages as any,
      members as any,
      permissions as any,
      authorization as any,
    );
    const context = {
      user,
      pageId: page.id,
      workspaceId: page.workspaceId,
      writeCapability: 'EDIT' as const,
    };
    const connection = { readOnly: true, close: jest.fn() };
    await extension.beforeHandleMessage({ context, connection } as any);
    await extension.beforeSync({ context, type: 0, connection } as any);
    connection.readOnly = false;
    await extension.beforeSync({ context, type: 2, connection } as any);
    await extension.beforeHandleAwareness({ context, connection } as any);
    await extension.onLoadDocument({ context } as any);
    expect(
      authorization.requirePage.mock.calls.map((call: any[]) => call[2]),
    ).toEqual(['VIEW', 'VIEW', 'VIEW', 'EDIT', 'VIEW', 'VIEW']);
  });

  it('fails closed immediately after Core revokes VIEW', async () => {
    const authorization = {
      page: jest.fn(),
      requirePage: jest.fn().mockRejectedValue(new UnauthorizedException()),
    };
    const extension = new AuthenticationExtension(
      token as any,
      users as any,
      pages as any,
      members as any,
      permissions as any,
      authorization as any,
    );
    const connection = { readOnly: false, close: jest.fn() };
    await expect(
      extension.beforeHandleMessage({
        context: {
          user,
          pageId: page.id,
          workspaceId: page.workspaceId,
          writeCapability: 'EDIT',
        },
        connection,
      } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(connection.close).toHaveBeenCalledWith({
      code: 4403,
      reason: 'authorization_revoked',
    });
  });
});
