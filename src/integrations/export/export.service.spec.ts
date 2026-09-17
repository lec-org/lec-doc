jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (value: string) => value,
}));

import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { User } from '@docmost/db/types/entity.types';
import { ExportService } from './export.service';

const user = { id: 'user', workspaceId: 'workspace' } as User;
const page = (id: string, parentPageId: string | null = null) => ({
  id,
  slugId: `${id}-slug`,
  title: id,
  icon: null,
  position: 'a0',
  parentPageId,
  spaceId: 'space',
  workspaceId: 'workspace',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  deletedAt: null,
  content: { type: 'doc', content: [{ type: 'paragraph' }] },
});

function makeService() {
  const pageRepo = {
    findPageTreeCandidates: jest.fn(),
    findAuthorizationSubject: jest.fn(),
    findAuthorizationSubjectsByIds: jest.fn(),
    findExportPagesByIds: jest.fn(),
  };
  const pagePermissionRepo = {
    filterAccessiblePageIds: jest.fn(),
  };
  const storageService = { read: jest.fn() };
  const lecAuthorization = {
    filterPages: jest.fn(),
    requirePage: jest.fn(),
    deny: jest.fn(() => {
      throw new ForbiddenException();
    }),
  };
  const domainService = { getUrl: jest.fn().mockReturnValue('https://docs') };
  const db = {};
  const service = new ExportService(
    pageRepo as any,
    pagePermissionRepo as any,
    db as any,
    storageService as any,
    {} as any,
    domainService as any,
    lecAuthorization as any,
  );
  return {
    service,
    pageRepo,
    pagePermissionRepo,
    storageService,
    lecAuthorization,
  };
}

describe('ExportService authorization', () => {
  it('does not load page content before Core VIEW allows export candidates', async () => {
    const deps = makeService();
    deps.pageRepo.findPageTreeCandidates.mockResolvedValue([
      {
        id: 'root',
        workspaceId: 'workspace',
        spaceId: 'space',
        parentPageId: null,
      },
    ]);
    deps.lecAuthorization.filterPages.mockResolvedValue([]);

    await expect(
      deps.service.exportPages('root', 'html', false, true, user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(deps.pageRepo.findExportPagesByIds).not.toHaveBeenCalled();
  });

  it('rechecks Core VIEW immediately before content load', async () => {
    const deps = makeService();
    const candidates = [page('root'), page('child', 'root')];
    deps.pageRepo.findPageTreeCandidates.mockResolvedValue(candidates);
    deps.pagePermissionRepo.filterAccessiblePageIds.mockResolvedValue([
      'root',
      'child',
    ]);
    deps.lecAuthorization.filterPages
      .mockResolvedValueOnce(candidates)
      .mockRejectedValueOnce(new ServiceUnavailableException());

    await expect(
      deps.service.exportPages('root', 'html', false, true, user),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(deps.lecAuthorization.filterPages).toHaveBeenCalledTimes(2);
    expect(deps.pageRepo.findExportPagesByIds).not.toHaveBeenCalled();
  });

  it('aborts when Core VIEW is revoked before the second page is archived', async () => {
    const deps = makeService();
    const pages = [page('root'), page('child', 'root')];
    deps.lecAuthorization.requirePage
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: true })
      .mockRejectedValueOnce(new ForbiddenException());
    const zip = { file: jest.fn(), folder: jest.fn().mockReturnThis() };

    await expect(
      deps.service.zipPages(
        { null: [pages[0]], root: [pages[1]] } as any,
        'html',
        zip as any,
        false,
        'https://docs',
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(deps.lecAuthorization.requirePage).toHaveBeenNthCalledWith(
      1,
      pages[0],
      user,
      'VIEW',
    );
    expect(deps.lecAuthorization.requirePage).toHaveBeenNthCalledWith(
      3,
      pages[1],
      user,
      'VIEW',
    );
    expect(zip.file).toHaveBeenCalledTimes(1);
  });

  it('rechecks the attachment owner immediately before storage.read', async () => {
    const deps = makeService();
    deps.lecAuthorization.requirePage.mockRejectedValue(
      new ServiceUnavailableException(),
    );
    const zip = { file: jest.fn() };
    const attachmentId = '019cfabc-16f1-7ba7-94da-1b72ff5d5567';
    const allowed = new Map([
      [
        attachmentId,
        {
          id: attachmentId,
          fileName: 'secret.pdf',
          filePath: 'workspace/secret.pdf',
          pageId: 'owner-page',
          workspaceId: 'workspace',
        },
      ],
    ]);

    await expect(
      deps.service.zipAttachments(
        {
          type: 'doc',
          content: [
            {
              type: 'attachment',
              attrs: { attachmentId, fileName: 'secret.pdf' },
            },
          ],
        },
        zip as any,
        allowed,
        user,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(deps.lecAuthorization.requirePage).toHaveBeenCalledWith(
      {
        id: 'owner-page',
        workspaceId: 'workspace',
        deletedAt: null,
      },
      user,
      'VIEW',
    );
    expect(deps.storageService.read).not.toHaveBeenCalled();
    expect(zip.file).not.toHaveBeenCalled();
  });

  it('removes denied transclusion references without emitting source ids', async () => {
    const deps = makeService();
    deps.pageRepo.findAuthorizationSubjectsByIds.mockResolvedValue([
      { id: 'allowed-source', workspaceId: 'workspace' },
      { id: 'denied-source', workspaceId: 'workspace' },
    ]);
    deps.lecAuthorization.filterPages.mockResolvedValue([
      { id: 'allowed-source', workspaceId: 'workspace' },
    ]);
    deps.pagePermissionRepo.filterAccessiblePageIds.mockResolvedValue([
      'allowed-source',
    ]);
    deps.lecAuthorization.requirePage.mockResolvedValue({ allowed: true });
    const zip = { file: jest.fn(), folder: jest.fn().mockReturnThis() };
    const exportedPage = {
      ...page('root'),
      content: {
        type: 'doc',
        content: [
          {
            type: 'transclusionReference',
            attrs: {
              sourcePageId: 'allowed-source',
              transclusionId: 'allowed-block',
            },
          },
          {
            type: 'transclusionReference',
            attrs: {
              sourcePageId: 'denied-source',
              transclusionId: 'denied-block',
              title: 'Denied title',
              content: 'Denied content',
            },
          },
        ],
      },
    };

    await deps.service.zipPages(
      { null: [exportedPage] } as any,
      'html',
      zip as any,
      false,
      'https://docs',
      user,
    );

    const output = String(zip.file.mock.calls[0][1]);
    expect(deps.lecAuthorization.filterPages).toHaveBeenCalledWith(
      [
        { id: 'allowed-source', workspaceId: 'workspace' },
        { id: 'denied-source', workspaceId: 'workspace' },
      ],
      user,
      'VIEW',
    );
    expect(output).toContain('allowed-source');
    expect(output).not.toContain('denied-source');
    expect(output).not.toContain('Denied title');
    expect(output).not.toContain('Denied content');
  });

  it('fails closed on transclusion authorization outage before archive output', async () => {
    const deps = makeService();
    deps.pageRepo.findAuthorizationSubjectsByIds.mockResolvedValue([
      { id: 'source', workspaceId: 'workspace' },
    ]);
    deps.lecAuthorization.filterPages.mockRejectedValue(
      new ServiceUnavailableException(),
    );
    deps.lecAuthorization.requirePage.mockResolvedValue({ allowed: true });
    const zip = { file: jest.fn(), folder: jest.fn().mockReturnThis() };
    const exportedPage = {
      ...page('root'),
      content: {
        type: 'doc',
        content: [
          {
            type: 'transclusionReference',
            attrs: { sourcePageId: 'source', transclusionId: 'block' },
          },
        ],
      },
    };

    await expect(
      deps.service.zipPages(
        { null: [exportedPage] } as any,
        'html',
        zip as any,
        false,
        'https://docs',
        user,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(zip.file).not.toHaveBeenCalled();
  });
});
