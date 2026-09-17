jest.mock('uuid', () => ({
  v7: jest.fn(),
  validate: jest.fn(() => true),
}));
jest.mock('nanoid', () => ({
  customAlphabet: jest.fn(() => jest.fn()),
}));

import { User } from '@docmost/db/types/entity.types';
import { LabelService } from './label.service';

const user = { id: 'user', workspaceId: 'workspace' } as User;

function service(labels: any, local: any, core: any) {
  return new LabelService(
    labels,
    local,
    {} as any,
    {} as any,
    core,
  );
}

describe('LabelService', () => {
  it('does not expose a directory label attached only to Core-denied pages', async () => {
    const label = {
      id: 'label-denied',
      name: 'secret',
      type: 'page',
      workspaceId: user.workspaceId,
      $cursor: 'label-cursor',
    };
    const labels = {
      findLabelCandidates: jest
        .fn()
        .mockResolvedValueOnce({
          items: [label],
          meta: { hasNextPage: false, nextCursor: null },
        }),
      findPageCandidatesByLabelIds: jest.fn().mockResolvedValue({
        items: [
          {
            labelId: label.id,
            id: 'denied-page',
            workspaceId: user.workspaceId,
          },
        ],
        meta: { nextCursor: null },
      }),
      findLabelContentByIds: jest.fn(),
    };
    const core = { filterPages: jest.fn().mockResolvedValue([]) };
    const local = { filterAccessiblePageIds: jest.fn() };

    await expect(
      service(labels as any, local as any, core as any).getLabels(
        user,
        'page' as any,
        { limit: 20 } as any,
      ),
    ).resolves.toEqual({
      items: [],
      meta: {
        limit: 20,
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null,
        prevCursor: null,
      },
    });
    expect(local.filterAccessiblePageIds).not.toHaveBeenCalled();
    expect(labels.findLabelContentByIds).not.toHaveBeenCalled();
  });

  it('returns the same info probe for missing and denied-only labels', async () => {
    const deniedLabels = {
      findIdByNameAndWorkspace: jest.fn().mockResolvedValue({
        id: 'label-denied',
        name: 'secret',
        workspaceId: user.workspaceId,
      }),
      findPageCandidatesByLabelIds: jest.fn().mockResolvedValue({
        items: [
          {
            labelId: 'label-denied',
            id: 'denied-page',
            workspaceId: user.workspaceId,
            $cursor: 'page-cursor',
          },
        ],
        meta: { hasNextPage: false, nextCursor: null },
      }),
    };
    const missingLabels = {
      findIdByNameAndWorkspace: jest.fn().mockResolvedValue(undefined),
    };
    const core = { filterPages: jest.fn().mockResolvedValue([]) };
    const local = { filterAccessiblePageIds: jest.fn() };

    const denied = await service(
      deniedLabels as any,
      local as any,
      core as any,
    ).getLabelInfo('Secret', 'page' as any, user);
    const missing = await service(
      missingLabels as any,
      local as any,
      core as any,
    ).getLabelInfo('Secret', 'page' as any, user);

    expect(denied).toEqual({ name: 'secret', usageCount: 0 });
    expect(missing).toEqual(denied);
    expect(local.filterAccessiblePageIds).not.toHaveBeenCalled();
  });

  it('counts only pages allowed by Core and then local ACL', async () => {
    const candidates = [
      { id: 'core-denied', workspaceId: user.workspaceId, $cursor: 'one' },
      { id: 'local-denied', workspaceId: user.workspaceId, $cursor: 'two' },
      { id: 'allowed', workspaceId: user.workspaceId, $cursor: 'three' },
    ];
    const labels = {
      findIdByNameAndWorkspace: jest.fn().mockResolvedValue({
        id: 'label',
        name: 'visible',
        workspaceId: user.workspaceId,
      }),
      findPageCandidatesByLabelIds: jest.fn().mockResolvedValue({
        items: candidates.map((candidate) => ({
          ...candidate,
          labelId: 'label',
        })),
        meta: { hasNextPage: false, nextCursor: null },
      }),
    };
    const core = {
      filterPages: jest.fn().mockResolvedValue(candidates.slice(1)),
    };
    const local = {
      filterAccessiblePageIds: jest.fn().mockResolvedValue(['allowed']),
    };

    await expect(
      service(labels as any, local as any, core as any).getLabelInfo(
        'Visible',
        'page' as any,
        user,
      ),
    ).resolves.toEqual({ name: 'visible', usageCount: 1 });
    expect(local.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: ['local-denied', 'allowed'],
      userId: user.id,
      spaceId: undefined,
    });
  });

  it('scans past 100 denied labeled pages before loading allowed metadata', async () => {
    const candidates = Array.from({ length: 101 }, (_, index) => ({
      id: `page-${index}`,
      workspaceId: user.workspaceId,
      updatedAt: new Date(101 - index),
      $cursor: `cursor-${index}`,
    }));
    const labels = {
      findPageCandidatesByLabelId: jest
        .fn()
        .mockResolvedValueOnce({
          items: candidates.slice(0, 100),
          meta: { hasNextPage: true, nextCursor: 'cursor-99' },
        })
        .mockResolvedValueOnce({
          items: candidates.slice(100),
          meta: { hasNextPage: false, nextCursor: null },
        }),
      findPageContentByIds: jest
        .fn()
        .mockResolvedValue([{ id: 'page-100', title: '允许页面' }]),
    };
    const core = {
      filterPages: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([candidates[100]]),
    };
    const local = {
      filterAccessiblePageIds: jest.fn().mockResolvedValue(['page-100']),
    };
    const service = new LabelService(
      labels as any,
      local as any,
      {} as any,
      {} as any,
      core as any,
    );

    await expect(
      service.findPagesByLabel('label', user, {
        pagination: { limit: 1 },
      } as any),
    ).resolves.toEqual({
      items: [{ id: 'page-100', title: '允许页面' }],
      meta: {
        limit: 1,
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null,
        prevCursor: null,
      },
    });
    expect(labels.findPageCandidatesByLabelId).toHaveBeenCalledTimes(2);
    expect(local.filterAccessiblePageIds).toHaveBeenLastCalledWith({
      pageIds: ['page-100'],
      userId: user.id,
      spaceId: undefined,
    });
    expect(labels.findPageContentByIds).toHaveBeenCalledWith(['page-100']);
    expect(core.filterPages.mock.calls[0][0][0]).toEqual({
      id: 'page-0',
      workspaceId: user.workspaceId,
    });
    expect(core.filterPages.mock.invocationCallOrder[0]).toBeLessThan(
      local.filterAccessiblePageIds.mock.invocationCallOrder[0],
    );
    expect(core.filterPages.mock.invocationCallOrder[1]).toBeLessThan(
      labels.findPageContentByIds.mock.invocationCallOrder[0],
    );
  });
});
