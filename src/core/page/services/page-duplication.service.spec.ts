jest.mock('uuid', () => ({
  v7: jest.fn(),
  validate: jest.fn(() => true),
}));

import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { v7 as uuid7, validate as isUuid } from 'uuid';
import { Page, User } from '@docmost/db/types/entity.types';
import { PageService } from './page.service';

const workspaceId = '30000000-0000-4000-8000-000000000001';
const sourceSpaceId = '40000000-0000-4000-8000-000000000001';
const targetSpaceId = '40000000-0000-4000-8000-000000000002';
const rootId = '50000000-0000-4000-8000-000000000001';
const childId = '50000000-0000-4000-8000-000000000002';
const deniedId = '50000000-0000-4000-8000-000000000003';
const deniedGrandchildId = '50000000-0000-4000-8000-000000000004';
const newRootId = '60000000-0000-4000-8000-000000000001';
const newChildId = '60000000-0000-4000-8000-000000000002';
const oldAttachmentId1 = '70000000-0000-4000-8000-000000000001';
const oldAttachmentId2 = '70000000-0000-4000-8000-000000000002';
const newAttachmentId1 = '80000000-0000-4000-8000-000000000001';
const newAttachmentId2 = '80000000-0000-4000-8000-000000000002';
const content = { type: 'doc', content: [] };
const user = {
  id: '20000000-0000-4000-8000-000000000001',
  workspaceId,
} as User;
const rootPage = {
  id: rootId,
  slugId: 'root-slug',
  title: 'Root',
  position: 'a0',
  parentPageId: null,
  spaceId: sourceSpaceId,
  workspaceId,
  deletedAt: null,
} as Page;
const candidates = [
  {
    id: rootId,
    parentPageId: null,
    spaceId: sourceSpaceId,
    workspaceId,
  },
  {
    id: childId,
    parentPageId: rootId,
    spaceId: sourceSpaceId,
    workspaceId,
  },
];

function setup() {
  const pageRepo = {
    findPageTreeCandidates: jest.fn().mockResolvedValue(candidates),
    findExportPagesByIds: jest.fn(),
    insertPage: jest.fn(),
    findById: jest.fn(),
  };
  const permissions = { filterAccessiblePageIds: jest.fn() };
  const authorization = {
    filterPages: jest.fn(),
    requireSpace: jest.fn(),
    requirePage: jest.fn(),
    principal: jest.fn(),
    deny: jest.fn(() => {
      throw new ForbiddenException();
    }),
  };
  const lifecycle = { createPage: jest.fn() };
  const storage = { copy: jest.fn() };
  const db = { selectFrom: jest.fn(), insertInto: jest.fn() };
  const transclusions = {
    insertTransclusionsForPages: jest.fn().mockResolvedValue(undefined),
    insertReferencesForPages: jest.fn().mockResolvedValue(undefined),
  };
  const service = Object.assign(Object.create(PageService.prototype), {
    pageRepo,
    pagePermissionRepo: permissions,
    lecAuthorization: authorization,
    lifecycle,
    storageService: storage,
    db,
    transclusionService: transclusions,
    nextPagePosition: jest.fn().mockResolvedValue('z0'),
    logger: { error: jest.fn() },
  }) as PageService;
  return {
    service,
    pageRepo,
    permissions,
    authorization,
    lifecycle,
    storage,
    db,
    transclusions,
  };
}

describe('PageService duplicate authorization and lifecycle', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (isUuid as jest.Mock).mockReturnValue(true);
  });

  it('denies the whole copy when Core denies a descendant before sensitive reads or writes', async () => {
    const deps = setup();
    deps.authorization.filterPages.mockResolvedValue([candidates[0]]);

    await expect(
      deps.service.duplicatePage(rootPage, targetSpaceId, user),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(deps.authorization.filterPages).toHaveBeenCalledWith(
      candidates,
      user,
      'VIEW',
    );
    expect(deps.authorization.requireSpace).not.toHaveBeenCalled();
    expect(deps.permissions.filterAccessiblePageIds).not.toHaveBeenCalled();
    expect(deps.pageRepo.findExportPagesByIds).not.toHaveBeenCalled();
    expect(deps.db.selectFrom).not.toHaveBeenCalled();
    expect(deps.storage.copy).not.toHaveBeenCalled();
    expect(deps.lifecycle.createPage).not.toHaveBeenCalled();
  });

  it('does not read content or write documents when target-space CREATE is unavailable', async () => {
    const deps = setup();
    deps.authorization.filterPages.mockResolvedValue(candidates);
    deps.authorization.requireSpace.mockRejectedValue(
      new ServiceUnavailableException(),
    );

    await expect(
      deps.service.duplicatePage(rootPage, targetSpaceId, user),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(deps.authorization.requireSpace).toHaveBeenCalledWith(
      targetSpaceId,
      workspaceId,
      user,
      'CREATE',
    );
    expect(deps.permissions.filterAccessiblePageIds).not.toHaveBeenCalled();
    expect(deps.pageRepo.findExportPagesByIds).not.toHaveBeenCalled();
    expect(deps.db.selectFrom).not.toHaveBeenCalled();
    expect(deps.lifecycle.createPage).not.toHaveBeenCalled();
  });

  it('aborts attachment copy when source VIEW is revoked after target page creation', async () => {
    const deps = setup();
    const attachmentContent = {
      type: 'doc',
      content: [
        {
          type: 'attachment',
          attrs: {
            attachmentId: oldAttachmentId1,
            url: `/api/files/${oldAttachmentId1}/one.png`,
          },
        },
      ],
    };
    deps.pageRepo.findPageTreeCandidates.mockResolvedValue([candidates[0]]);
    deps.authorization.filterPages.mockResolvedValue([candidates[0]]);
    deps.authorization.requireSpace.mockResolvedValue(undefined);
    deps.authorization.principal.mockResolvedValue({
      type: 'OIDC',
      issuer: 'https://issuer.example.com',
      subject: 'subject',
    });
    deps.permissions.filterAccessiblePageIds.mockResolvedValue([rootId]);
    deps.pageRepo.findExportPagesByIds.mockResolvedValue([
      { ...rootPage, content: attachmentContent },
    ]);
    (uuid7 as jest.Mock)
      .mockReturnValueOnce(newRootId)
      .mockReturnValueOnce(newAttachmentId1);
    deps.lifecycle.createPage.mockImplementation(
      async (
        _user: User,
        _principal: unknown,
        _id: string,
        _kind: string,
        _parentId: string,
        insert: (trx: unknown) => unknown,
      ) => insert({}),
    );
    deps.authorization.requirePage.mockRejectedValue(new ForbiddenException());
    const attachments = {
      selectAll: jest.fn(),
      where: jest.fn(),
      execute: jest.fn().mockResolvedValue([
        {
          id: oldAttachmentId1,
          pageId: rootId,
          workspaceId,
          filePath: `/files/${oldAttachmentId1}/one.png`,
          fileName: 'one.png',
          fileExt: 'png',
        },
      ]),
    };
    attachments.selectAll.mockReturnValue(attachments);
    attachments.where.mockReturnValue(attachments);
    deps.db.selectFrom.mockReturnValue(attachments);

    await expect(
      deps.service.duplicatePage(rootPage, targetSpaceId, user),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(deps.lifecycle.createPage).toHaveBeenCalledTimes(1);
    expect(deps.authorization.requirePage).toHaveBeenCalledWith(
      expect.objectContaining({ id: rootId, workspaceId, deletedAt: null }),
      user,
      'VIEW',
    );
    expect(deps.storage.copy).not.toHaveBeenCalled();
    expect(deps.db.insertInto).not.toHaveBeenCalled();
  });

  it('rechecks source VIEW and target EDIT between attachments and aborts on Core outage', async () => {
    const deps = setup();
    const attachmentContent = {
      type: 'doc',
      content: [oldAttachmentId1, oldAttachmentId2].map((attachmentId) => ({
        type: 'attachment',
        attrs: {
          attachmentId,
          url: `/api/files/${attachmentId}/file.png`,
        },
      })),
    };
    deps.pageRepo.findPageTreeCandidates.mockResolvedValue([candidates[0]]);
    deps.authorization.filterPages.mockResolvedValue([candidates[0]]);
    deps.authorization.requireSpace.mockResolvedValue(undefined);
    deps.authorization.principal.mockResolvedValue({
      type: 'OIDC',
      issuer: 'https://issuer.example.com',
      subject: 'subject',
    });
    deps.permissions.filterAccessiblePageIds.mockResolvedValue([rootId]);
    deps.pageRepo.findExportPagesByIds.mockResolvedValue([
      { ...rootPage, content: attachmentContent },
    ]);
    (uuid7 as jest.Mock)
      .mockReturnValueOnce(newRootId)
      .mockReturnValueOnce(newAttachmentId1)
      .mockReturnValueOnce(newAttachmentId2);
    deps.lifecycle.createPage.mockImplementation(
      async (
        _user: User,
        _principal: unknown,
        _id: string,
        _kind: string,
        _parentId: string,
        insert: (trx: unknown) => unknown,
      ) => insert({}),
    );
    deps.authorization.requirePage
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ServiceUnavailableException());
    const attachments = {
      selectAll: jest.fn(),
      where: jest.fn(),
      execute: jest.fn().mockResolvedValue([
        {
          id: oldAttachmentId1,
          pageId: rootId,
          workspaceId,
          filePath: `/files/${oldAttachmentId1}/one.png`,
          fileName: 'one.png',
          fileExt: 'png',
        },
        {
          id: oldAttachmentId2,
          pageId: rootId,
          workspaceId,
          filePath: `/files/${oldAttachmentId2}/two.png`,
          fileName: 'two.png',
          fileExt: 'png',
        },
      ]),
    };
    attachments.selectAll.mockReturnValue(attachments);
    attachments.where.mockReturnValue(attachments);
    deps.db.selectFrom.mockReturnValue(attachments);
    const execute = jest.fn().mockResolvedValue(undefined);
    const values = jest.fn().mockReturnValue({ execute });
    deps.db.insertInto.mockReturnValue({ values });

    await expect(
      deps.service.duplicatePage(rootPage, targetSpaceId, user),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(deps.storage.copy).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(deps.authorization.requirePage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: rootId }),
      user,
      'VIEW',
    );
    expect(deps.authorization.requirePage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: newRootId }),
      user,
      'EDIT',
    );
    expect(deps.authorization.requirePage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ id: rootId }),
      user,
      'VIEW',
    );
    expect(deps.authorization.requirePage).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ id: newRootId }),
      user,
      'EDIT',
    );
    expect(deps.authorization.requirePage).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({ id: rootId }),
      user,
      'VIEW',
    );
  });

  it('locally narrows the authorized tree and creates retained pages parent-first through lifecycle', async () => {
    const deps = setup();
    const tree = [
      candidates[1],
      {
        id: deniedGrandchildId,
        parentPageId: deniedId,
        spaceId: sourceSpaceId,
        workspaceId,
      },
      candidates[0],
      {
        id: deniedId,
        parentPageId: rootId,
        spaceId: sourceSpaceId,
        workspaceId,
      },
    ];
    deps.pageRepo.findPageTreeCandidates.mockResolvedValue(tree);
    deps.authorization.filterPages.mockResolvedValue(tree);
    deps.authorization.requireSpace.mockResolvedValue(undefined);
    deps.authorization.principal.mockResolvedValue({
      type: 'OIDC',
      issuer: 'https://issuer.example.com',
      subject: 'subject',
    });
    deps.permissions.filterAccessiblePageIds.mockResolvedValue([
      rootId,
      childId,
      deniedGrandchildId,
    ]);
    deps.pageRepo.findExportPagesByIds.mockResolvedValue([
      { ...rootPage, content },
      {
        ...rootPage,
        id: childId,
        slugId: 'child-slug',
        title: 'Child',
        position: 'a1',
        parentPageId: rootId,
        content,
      },
    ]);
    (uuid7 as jest.Mock)
      .mockReturnValueOnce(newRootId)
      .mockReturnValueOnce(newChildId);
    deps.pageRepo.insertPage.mockImplementation(async (page: Page) => page);
    deps.lifecycle.createPage.mockImplementation(
      async (
        _user: User,
        _principal: unknown,
        _id: string,
        _kind: string,
        _parentId: string,
        insert: (trx: unknown) => unknown,
      ) => insert({}),
    );
    deps.pageRepo.findById.mockResolvedValue({
      ...rootPage,
      id: newRootId,
      spaceId: targetSpaceId,
    });

    const result = await deps.service.duplicatePage(
      rootPage,
      targetSpaceId,
      user,
    );

    expect(deps.pageRepo.findExportPagesByIds.mock.calls[0][0]).toEqual(
      expect.arrayContaining([rootId, childId]),
    );
    expect(
      deps.authorization.requireSpace.mock.invocationCallOrder[0],
    ).toBeLessThan(
      deps.pageRepo.findExportPagesByIds.mock.invocationCallOrder[0],
    );
    expect(deps.lifecycle.createPage).toHaveBeenNthCalledWith(
      1,
      user,
      expect.objectContaining({ type: 'OIDC' }),
      newRootId,
      'DOCMOST_SPACE',
      targetSpaceId,
      expect.any(Function),
    );
    expect(deps.lifecycle.createPage).toHaveBeenNthCalledWith(
      2,
      user,
      expect.objectContaining({ type: 'OIDC' }),
      newChildId,
      'DOCMOST_PAGE',
      newRootId,
      expect.any(Function),
    );
    expect(result.childPageIds).toEqual([newChildId]);
  });
});
