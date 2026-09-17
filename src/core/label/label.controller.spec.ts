jest.mock('uuid', () => ({
  v7: jest.fn(),
  validate: jest.fn(() => true),
}));
jest.mock('nanoid', () => ({
  customAlphabet: jest.fn(() => jest.fn()),
}));

import { NotFoundException } from '@nestjs/common';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { LabelController } from './label.controller';

const user = { id: 'user', workspaceId: 'workspace' } as User;
const workspace = { id: 'workspace' } as Workspace;

describe('LabelController', () => {
  it('returns the same empty shape for missing and denied-only label names', async () => {
    const labels = {
      findIdByNameAndWorkspace: jest.fn().mockResolvedValue(undefined),
    };
    const service = {
      hasAuthorizedPages: jest.fn().mockResolvedValue(false),
      findPagesByLabel: jest.fn(),
    };
    const controller = new LabelController(
      service as any,
      labels as any,
      {} as any,
    );

    const missing = await controller.findPagesByLabel(
      { name: 'missing' } as any,
      { limit: 20 } as any,
      user,
      workspace,
    );

    labels.findIdByNameAndWorkspace.mockResolvedValueOnce({ id: 'denied-label' });
    const denied = await controller.findPagesByLabel(
      { name: 'denied' } as any,
      { limit: 20 } as any,
      user,
      workspace,
    );

    expect(denied).toEqual(missing);
  });

  it('exposes a uniform label info endpoint backed by authorized counts', async () => {
    const service = {
      getLabelInfo: jest.fn().mockResolvedValue({ name: 'secret', usageCount: 0 }),
    };
    const controller = new LabelController(
      service as any,
      {} as any,
      {} as any,
    );

    await expect(
      controller.getLabelInfo(
        { name: 'Secret', type: 'page' } as any,
        user,
        workspace,
      ),
    ).resolves.toEqual({ name: 'secret', usageCount: 0 });
    expect(service.getLabelInfo).toHaveBeenCalledWith(
      'Secret',
      'page',
      user,
      undefined,
    );
  });

  it('does not resolve a same-workspace labelId attached only to denied pages', async () => {
    const labels = {
      findByIdAndWorkspace: jest.fn().mockResolvedValue({ id: 'denied-label' }),
    };
    const service = {
      hasAuthorizedPages: jest.fn().mockResolvedValue(false),
      findPagesByLabel: jest.fn(),
    };
    const controller = new LabelController(
      service as any,
      labels as any,
      {} as any,
    );

    await expect(
      controller.findPagesByLabel(
        { labelId: 'denied-label' } as any,
        { limit: 20 } as any,
        user,
        workspace,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(service.findPagesByLabel).not.toHaveBeenCalled();
  });

  it('does not resolve a labelId outside the authenticated workspace', async () => {
    const labels = {
      findByIdAndWorkspace: jest.fn().mockResolvedValue(undefined),
    };
    const service = { findPagesByLabel: jest.fn() };
    const controller = new LabelController(
      service as any,
      labels as any,
      {} as any,
    );

    await expect(
      controller.findPagesByLabel(
        { labelId: 'other-workspace-label' } as any,
        { limit: 20 } as any,
        user,
        workspace,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(labels.findByIdAndWorkspace).toHaveBeenCalledWith(
      'other-workspace-label',
      workspace.id,
    );
    expect(service.findPagesByLabel).not.toHaveBeenCalled();
  });
});
