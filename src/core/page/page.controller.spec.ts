jest.mock('uuid', () => ({
  v7: jest.fn(),
  validate: jest.fn(() => true),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { PageController } from './page.controller';
import { PageService } from './services/page.service';
import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';

describe('PageController', () => {
  let controller: PageController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PageController],
      providers: [PageService],
    })
      // 构造器冒烟测试隔离外部依赖；业务和权限行为由各自用例验证。
      .useMocker(() => ({}))
      .compile();

    controller = module.get<PageController>(PageController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

const USER = {
  id: '10000000-0000-4000-8000-000000000001',
  workspaceId: '20000000-0000-4000-8000-000000000001',
} as any;
const CONTROL_DTO = {
  pageId: '30000000-0000-4000-8000-000000000001',
  operationId: '40000000-0000-4000-8000-000000000001',
  expectedVersion: 2,
};

function controlController(error?: Error) {
  const methods = [
    'classify',
    'transferOwner',
    'revokeGrant',
    'requestAccess',
    'reviewAccess',
    'revokeAccess',
  ] as const;
  const control = Object.fromEntries(
    methods.map((method) => [
      method,
      error
        ? jest.fn().mockRejectedValue(error)
        : jest.fn().mockResolvedValue({ method }),
    ]),
  );
  const controller = new PageController(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    control as any,
    {} as any,
  );
  return { controller, control };
}

const controls = [
  ['classify', { ...CONTROL_DTO, classification: 4 }],
  [
    'transferOwner',
    {
      ...CONTROL_DTO,
      ownerUserId: '50000000-0000-4000-8000-000000000001',
    },
  ],
  [
    'revokeGrant',
    { ...CONTROL_DTO, grantId: '60000000-0000-4000-8000-000000000001' },
  ],
  ['requestAccess', { pageId: CONTROL_DTO.pageId, reason: 'Need access' }],
  [
    'reviewAccess',
    {
      ...CONTROL_DTO,
      accessRequestId: '70000000-0000-4000-8000-000000000001',
      decision: 'APPROVE',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    },
  ],
  [
    'revokeAccess',
    {
      ...CONTROL_DTO,
      accessRequestId: '70000000-0000-4000-8000-000000000001',
    },
  ],
] as const;

describe('PageController container authorization', () => {
  it('returns no breadcrumbs and never loads ancestors for page-only access', async () => {
    const page = {
      id: CONTROL_DTO.pageId,
      workspaceId: USER.workspaceId,
      spaceId: '50000000-0000-4000-8000-000000000001',
    };
    const pageService = { getPageBreadCrumbs: jest.fn() };
    const pageRepo = { findById: jest.fn().mockResolvedValue(page) };
    const pageAccess = { validateCanView: jest.fn().mockResolvedValue(undefined) };
    const core = {
      requireSpace: jest.fn().mockRejectedValue(new ForbiddenException()),
      filterPages: jest.fn(),
    };
    const controller = new PageController(
      pageService as any,
      pageRepo as any,
      {} as any,
      { createForUser: jest.fn() } as any,
      pageAccess as any,
      {} as any,
      {} as any,
      core as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      controller.getPageBreadcrumbs({ pageId: page.id }, USER),
    ).resolves.toEqual([]);
    expect(pageAccess.validateCanView).toHaveBeenCalledWith(page, USER);
    expect(core.requireSpace).toHaveBeenCalledWith(
      page.spaceId,
      page.workspaceId,
      USER,
      'VIEW',
    );
    expect(pageService.getPageBreadCrumbs).not.toHaveBeenCalled();
    expect(core.filterPages).not.toHaveBeenCalled();
  });
});

describe('PageController public control API', () => {
  it.each(controls)(
    'forwards valid %s requests with the authenticated user',
    async (method, dto) => {
      const { controller, control } = controlController();

      await expect((controller[method] as any)(dto, USER)).resolves.toEqual({
        method,
      });
      expect(control[method]).toHaveBeenCalledWith(USER, dto);
    },
  );

  it.each(
    controls.flatMap(([method, dto]) => [
      [method, dto, new ForbiddenException({ code: 'DOC_FORBIDDEN' })],
      [
        method,
        dto,
        new ServiceUnavailableException({
          code: 'DOC_AUTHORIZATION_UNAVAILABLE',
        }),
      ],
    ]),
  )(
    'propagates %s deny/outage without fallback',
    async (method, dto, error) => {
      const { controller } = controlController(error);

      await expect((controller[method] as any)(dto, USER)).rejects.toBe(error);
    },
  );
});
