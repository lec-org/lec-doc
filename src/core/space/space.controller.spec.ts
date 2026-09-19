import { ServiceUnavailableException } from '@nestjs/common';
import { SpaceController } from './space.controller';

const user = { id: 'user', workspaceId: 'workspace' } as any;
const workspace = { id: 'workspace' } as any;

function subject(overrides: Record<string, any> = {}) {
  const dependencies = {
    spaces: { getSpaceInfo: jest.fn() },
    members: { getUserSpaces: jest.fn() },
    memberRepo: {
      getUserRolesForSpaces: jest.fn(),
      getUserSpaceRoles: jest.fn(),
    },
    spaceAbility: { createForUser: jest.fn() },
    workspaceAbility: { createForUser: jest.fn() },
    core: { filterSpaces: jest.fn(), requireSpace: jest.fn() },
    ...overrides,
  };
  return {
    dependencies,
    controller: new SpaceController(
      dependencies.spaces as any,
      dependencies.members as any,
      dependencies.memberRepo as any,
      dependencies.spaceAbility as any,
      dependencies.workspaceAbility as any,
      dependencies.core as any,
    ),
  };
}

describe('SpaceController container authorization', () => {
  it('filters workspace spaces through Core SPACE VIEW before hydrating membership', async () => {
    const { controller, dependencies } = subject();
    const allowed = { id: 'allowed', workspaceId: workspace.id };
    const denied = { id: 'denied', workspaceId: workspace.id };
    dependencies.members.getUserSpaces.mockResolvedValue({
      items: [allowed, denied],
      meta: { limit: 20 },
    });
    dependencies.core.filterSpaces.mockResolvedValue([allowed]);
    dependencies.memberRepo.getUserRolesForSpaces.mockResolvedValue([
      { spaceId: allowed.id, role: 'member' },
    ]);

    await expect(
      controller.getWorkspaceSpaces({ limit: 20 } as any, user),
    ).resolves.toEqual({
      items: [
        {
          ...allowed,
          membership: { userId: user.id, role: 'member' },
        },
      ],
      meta: { limit: 20 },
    });
    expect(dependencies.core.filterSpaces).toHaveBeenCalledWith(
      [allowed, denied],
      user,
    );
    expect(
      dependencies.memberRepo.getUserRolesForSpaces,
    ).toHaveBeenCalledWith(user.id, [allowed.id]);
  });

  it('fails closed before local ability or role lookup when Core space check is unavailable', async () => {
    const { controller, dependencies } = subject();
    const space = {
      id: 'space',
      workspaceId: workspace.id,
      isPersonal: false,
      creatorId: 'owner',
    };
    dependencies.spaces.getSpaceInfo.mockResolvedValue(space);
    dependencies.core.requireSpace.mockRejectedValue(
      new ServiceUnavailableException(),
    );

    await expect(
      controller.getSpaceInfo({ spaceId: space.id }, user, workspace),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(dependencies.core.requireSpace).toHaveBeenCalledWith(
      space.id,
      workspace.id,
      user,
      'VIEW',
    );
    expect(dependencies.spaceAbility.createForUser).not.toHaveBeenCalled();
    expect(dependencies.memberRepo.getUserSpaceRoles).not.toHaveBeenCalled();
  });
});
