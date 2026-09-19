import { Test, TestingModule } from '@nestjs/testing';
import { SpaceService } from './space.service';

describe('SpaceService', () => {
  let service: SpaceService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SpaceService],
    })
      // 构造器冒烟测试隔离外部依赖；业务和权限行为由各自用例验证。
      .useMocker(() => ({}))
      .compile();

    service = module.get<SpaceService>(SpaceService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('writes one personal-space bind intent in the same transaction', async () => {
    const space = { id: 'space-1', name: 'Private', slug: 'private', isPersonal: true };
    const trx = {} as any;
    const spaceRepo = (service as any).spaceRepo;
    const members = (service as any).spaceMemberService;
    const authorization = (service as any).authorization;
    const lifecycle = (service as any).lifecycle;
    const audit = (service as any).auditService;
    spaceRepo.slugExists = jest.fn().mockResolvedValue(false);
    spaceRepo.insertSpace = jest.fn().mockResolvedValue(space);
    members.addUserToSpace = jest.fn().mockResolvedValue(undefined);
    authorization.principal = jest.fn().mockResolvedValue({
      type: 'OIDC',
      issuer: 'https://id.example.test/oidc',
      subject: 'owner-subject',
    });
    lifecycle.createSpaceBindIntent = jest.fn().mockResolvedValue(undefined);
    audit.log = jest.fn();

    await service.createSpace(
      { id: 'user-1', workspaceId: 'workspace-1' } as any,
      'workspace-1',
      { name: 'Private', slug: 'private' } as any,
      trx,
      { isPersonal: true },
    );

    expect(lifecycle.createSpaceBindIntent).toHaveBeenCalledTimes(1);
    expect(lifecycle.createSpaceBindIntent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      expect.objectContaining({ subject: 'owner-subject' }),
      space.id,
      true,
      trx,
    );
  });
});
