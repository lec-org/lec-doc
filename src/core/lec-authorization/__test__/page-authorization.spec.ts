import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { LecAuthorizationService } from '../lec-authorization.service';
import { PageAccessService } from '../../page/page-access/page-access.service';

const page = {
  id: 'page',
  workspaceId: 'workspace',
  spaceId: 'space',
  deletedAt: null,
} as any;
const user = { id: 'user', workspaceId: 'workspace' } as any;

describe('页面共享授权入口', () => {
  const policy = { authorize: jest.fn() };
  const identities = { findByUserId: jest.fn() };
  const permissions = { canUserEditPage: jest.fn() };
  const space = { createForUser: jest.fn() };
  const spaces = { findById: jest.fn() };
  let authorization: LecAuthorizationService;
  let access: PageAccessService;
  beforeEach(() => {
    jest.resetAllMocks();
    identities.findByUserId.mockResolvedValue({
      issuer: 'https://issuer.example.test',
      subject: 'subject',
    });
    permissions.canUserEditPage.mockResolvedValue({
      hasAnyRestriction: false,
      canAccess: true,
      canEdit: true,
    });
    space.createForUser.mockResolvedValue({ can: () => true });
    spaces.findById.mockResolvedValue({
      settings: { comments: { allowViewerComments: true } },
    });
    authorization = new LecAuthorizationService(
      identities as any,
      policy as any,
    );
    access = new PageAccessService(
      permissions as any,
      space as any,
      spaces as any,
      authorization,
    );
  });
  it.each([
    ['validateCanView', () => access.validateCanView(page, user)],
    ['validateCanEdit', () => access.validateCanEdit(page, user)],
    [
      'validateCanViewWithPermissions',
      () => access.validateCanViewWithPermissions(page, user),
    ],
    [
      'validateCanComment',
      () => access.validateCanComment(page, user, page.workspaceId),
    ],
  ])('%s 不因本地 Owner/CASL allow 绕过 Core 故障', async (_method, invoke) => {
    policy.authorize.mockRejectedValue(new ServiceUnavailableException());
    await expect(invoke()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(permissions.canUserEditPage).not.toHaveBeenCalled();
  });
  it('VIEW grant 不升级 canEdit', async () => {
    policy.authorize.mockResolvedValue([{ allowed: true }, { allowed: false }]);
    expect(await access.validateCanViewWithPermissions(page, user)).toEqual({
      canEdit: false,
      hasRestriction: false,
    });
  });
  it('COMMENT deny 不进入 reader comment 回退', async () => {
    policy.authorize.mockResolvedValue([{ allowed: false }]);
    await expect(
      access.validateCanComment(page, user, page.workspaceId),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('拒绝跨 workspace 和缺少稳定身份，且不向 Core 发送伪造主体', async () => {
    await expect(
      authorization.check(
        { ...user, workspaceId: 'other' },
        page.workspaceId,
        [],
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    identities.findByUserId.mockResolvedValue(undefined);
    await expect(
      authorization.check(user, page.workspaceId, []),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(policy.authorize).not.toHaveBeenCalled();
  });
  it('恢复子树只要求根节点预检允许，后代交给 Core tree 命令按同批父级恢复判定', async () => {
    policy.authorize.mockResolvedValue([
      { resource_id: 'root', resource_version: 3, allowed: true },
      { resource_id: 'child', resource_version: 3, allowed: false },
    ]);
    await expect(
      authorization.requireTree(
        [
          { id: 'root', workspaceId: 'workspace' },
          { id: 'child', workspaceId: 'workspace' },
        ] as any,
        user,
        'RESTORE',
        'root',
      ),
    ).resolves.toHaveLength(2);
  });
  it('删除子树仍要求每个节点在线允许', async () => {
    policy.authorize.mockResolvedValue([
      { resource_id: 'root', resource_version: 3, allowed: true },
      { resource_id: 'child', resource_version: 3, allowed: false },
    ]);
    await expect(
      authorization.requireTree(
        [
          { id: 'root', workspaceId: 'workspace' },
          { id: 'child', workspaceId: 'workspace' },
        ] as any,
        user,
        'DELETE',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('列表按 Core 上限分批并保持原顺序，只返回在线允许页面', async () => {
    const pages = Array.from({ length: 101 }, (_, index) => ({
      id: `page-${index}`,
      workspaceId: 'workspace',
    }));
    policy.authorize
      .mockResolvedValueOnce(
        pages.slice(0, 100).map((candidate, index) => ({
          resource_id: candidate.id,
          allowed: index % 2 === 0,
        })),
      )
      .mockResolvedValueOnce([
        { resource_id: pages[100].id, allowed: true },
      ]);
    const allowed = await authorization.filterPages(pages as any, user);
    expect(policy.authorize).toHaveBeenCalledTimes(2);
    expect(allowed.map((candidate) => candidate.id)).toEqual([
      ...pages.slice(0, 100).filter((_, index) => index % 2 === 0),
      pages[100],
    ].map((candidate) => candidate.id));
  });
  it('本地限制可以进一步收紧 Core allow', async () => {
    policy.authorize.mockResolvedValue([{ allowed: true }]);
    permissions.canUserEditPage.mockResolvedValue({
      hasAnyRestriction: true,
      canAccess: false,
      canEdit: false,
    });
    await expect(access.validateCanView(page, user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
