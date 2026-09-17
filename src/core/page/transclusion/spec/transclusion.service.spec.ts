import { ServiceUnavailableException } from '@nestjs/common';
import { TransclusionService } from '../transclusion.service';

const viewer = { id: 'viewer-1', workspaceId: 'workspace-1' } as any;

function makeService() {
  const pageTransclusionsRepo = {
    findManyByPageAndTransclusion: jest.fn().mockResolvedValue([]),
  };
  const pageTransclusionReferencesRepo = {
    findReferencePageIdsByTransclusion: jest.fn().mockResolvedValue([]),
  };
  const pageRepo = {
    findManyByIds: jest.fn().mockResolvedValue([]),
    findById: jest.fn(),
  };
  const pagePermissionRepo = {
    filterAccessiblePageIds: jest.fn().mockResolvedValue([]),
  };
  const spaceMemberRepo = {
    getUserSpaceIdsQuery: jest.fn().mockReturnValue({}),
  };
  const lecAuthorization = { filterPages: jest.fn() };

  const query = {
    select: jest.fn(),
    where: jest.fn(),
    execute: jest.fn().mockResolvedValue([]),
  };
  query.select.mockReturnValue(query);
  query.where.mockReturnValue(query);
  const db = { selectFrom: jest.fn().mockReturnValue(query) };

  const service = new TransclusionService(
    db as any,
    pageTransclusionsRepo as any,
    pageTransclusionReferencesRepo as any,
    pageRepo as any,
    pagePermissionRepo as any,
    spaceMemberRepo as any,
    {} as any,
    {} as any,
    {} as any,
    lecAuthorization as any,
  );

  return {
    service,
    db,
    query,
    pageTransclusionsRepo,
    pageTransclusionReferencesRepo,
    pageRepo,
    pagePermissionRepo,
    spaceMemberRepo,
    lecAuthorization,
  };
}

describe('TransclusionService authenticated authorization', () => {
  it('fails closed before local ACL or source content when Core VIEW is unavailable', async () => {
    const deps = makeService();
    deps.lecAuthorization.filterPages.mockRejectedValue(
      new ServiceUnavailableException(),
    );

    await expect(
      deps.service.lookup(
        [{ sourcePageId: 'source-1', transclusionId: 'block-1' }],
        viewer,
        viewer.workspaceId,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(deps.lecAuthorization.filterPages).toHaveBeenCalledWith(
      [{ id: 'source-1', workspaceId: 'workspace-1' }],
      viewer,
      'VIEW',
    );
    expect(deps.db.selectFrom).not.toHaveBeenCalled();
    expect(
      deps.pagePermissionRepo.filterAccessiblePageIds,
    ).not.toHaveBeenCalled();
    expect(
      deps.pageTransclusionsRepo.findManyByPageAndTransclusion,
    ).not.toHaveBeenCalled();
    expect(deps.pageRepo.findManyByIds).not.toHaveBeenCalled();
  });

  it('authorizes all source candidates first, then lets local ACL only narrow', async () => {
    const deps = makeService();
    deps.lecAuthorization.filterPages.mockResolvedValue([
      { id: 'source-1', workspaceId: 'workspace-1' },
      { id: 'source-2', workspaceId: 'workspace-1' },
    ]);
    deps.query.execute.mockResolvedValue([{ id: 'source-1' }]);
    deps.pagePermissionRepo.filterAccessiblePageIds.mockResolvedValue([
      'source-1',
    ]);
    deps.pageTransclusionsRepo.findManyByPageAndTransclusion.mockResolvedValue([
      {
        pageId: 'source-1',
        transclusionId: 'block-1',
        content: { type: 'paragraph' },
      },
    ]);
    deps.pageRepo.findManyByIds.mockResolvedValue([
      { id: 'source-1', updatedAt: new Date('2026-01-01T00:00:00Z') },
    ]);

    const references = [
      { sourcePageId: 'source-1', transclusionId: 'block-1' },
      { sourcePageId: 'source-2', transclusionId: 'block-2' },
      { sourcePageId: 'source-3', transclusionId: 'block-3' },
    ];
    const result = await deps.service.lookup(
      references,
      viewer,
      viewer.workspaceId,
    );

    expect(deps.lecAuthorization.filterPages).toHaveBeenCalledWith(
      references.map(({ sourcePageId: id }) => ({
        id,
        workspaceId: 'workspace-1',
      })),
      viewer,
      'VIEW',
    );
    expect(deps.query.where).toHaveBeenCalledWith('id', 'in', [
      'source-1',
      'source-2',
    ]);
    expect(
      deps.pagePermissionRepo.filterAccessiblePageIds,
    ).toHaveBeenCalledWith({
      pageIds: ['source-1'],
      userId: 'viewer-1',
    });
    expect(
      deps.pageTransclusionsRepo.findManyByPageAndTransclusion,
    ).toHaveBeenCalledWith(
      [{ pageId: 'source-1', transclusionId: 'block-1' }],
      'workspace-1',
    );
    expect(deps.pageRepo.findManyByIds).toHaveBeenCalledWith(['source-1'], {
      workspaceId: 'workspace-1',
    });
    expect(result.items).toEqual([
      {
        sourcePageId: 'source-1',
        transclusionId: 'block-1',
        content: { type: 'paragraph' },
        sourceUpdatedAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        sourcePageId: 'source-2',
        transclusionId: 'block-2',
        status: 'no_access',
      },
      {
        sourcePageId: 'source-3',
        transclusionId: 'block-3',
        status: 'no_access',
      },
    ]);
  });

  it('fails closed before loading referencing-page title metadata', async () => {
    const deps = makeService();
    deps.pageTransclusionReferencesRepo.findReferencePageIdsByTransclusion.mockResolvedValue(
      ['reference-1'],
    );
    deps.lecAuthorization.filterPages.mockRejectedValue(
      new ServiceUnavailableException(),
    );

    await expect(
      deps.service.listReferences({
        sourcePageId: 'source-1',
        transclusionId: 'block-1',
        viewer,
        workspaceId: viewer.workspaceId,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(deps.lecAuthorization.filterPages).toHaveBeenCalledWith(
      [
        { id: 'source-1', workspaceId: 'workspace-1' },
        { id: 'reference-1', workspaceId: 'workspace-1' },
      ],
      viewer,
      'VIEW',
    );
    expect(deps.db.selectFrom).not.toHaveBeenCalled();
    expect(deps.pageRepo.findById).not.toHaveBeenCalled();
  });

  it('loads title metadata only for Core and locally VIEW-authorized references', async () => {
    const deps = makeService();
    deps.pageTransclusionReferencesRepo.findReferencePageIdsByTransclusion.mockResolvedValue(
      ['reference-1', 'reference-2'],
    );
    deps.lecAuthorization.filterPages.mockResolvedValue([
      { id: 'source-1', workspaceId: 'workspace-1' },
      { id: 'reference-1', workspaceId: 'workspace-1' },
    ]);
    deps.query.execute.mockResolvedValue([
      { id: 'source-1' },
      { id: 'reference-1' },
    ]);
    deps.pagePermissionRepo.filterAccessiblePageIds.mockResolvedValue([
      'reference-1',
    ]);
    deps.pageRepo.findById.mockResolvedValue({
      id: 'reference-1',
      slugId: 'reference-slug',
      title: 'Allowed title',
      icon: null,
      spaceId: 'space-1',
      workspaceId: 'workspace-1',
      deletedAt: null,
      space: { slug: 'space-slug' },
    });

    const result = await deps.service.listReferences({
      sourcePageId: 'source-1',
      transclusionId: 'block-1',
      viewer,
      workspaceId: viewer.workspaceId,
    });

    expect(
      deps.pagePermissionRepo.filterAccessiblePageIds,
    ).toHaveBeenCalledWith({
      pageIds: ['source-1', 'reference-1'],
      userId: 'viewer-1',
    });
    expect(deps.pageRepo.findById).toHaveBeenCalledTimes(1);
    expect(deps.pageRepo.findById).toHaveBeenCalledWith('reference-1', {
      includeSpace: true,
    });
    expect(result).toEqual({
      source: null,
      references: [
        {
          id: 'reference-1',
          slugId: 'reference-slug',
          title: 'Allowed title',
          icon: null,
          spaceId: 'space-1',
          spaceSlug: 'space-slug',
        },
      ],
    });
  });
});
