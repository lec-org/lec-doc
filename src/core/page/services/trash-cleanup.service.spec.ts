import { Test, TestingModule } from '@nestjs/testing';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { PageMaintenanceService } from './page-maintenance.service';
import { TrashCleanupService } from './trash-cleanup.service';

describe('TrashCleanupService', () => {
  const workspaceId = '00000000-0000-4000-8000-000000000001';
  const pageId = '00000000-0000-4000-8000-000000000002';
  const db = { selectFrom: jest.fn() };
  const pageMaintenance = { forceDelete: jest.fn() };
  let service: TrashCleanupService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [TrashCleanupService],
    })
      .useMocker((token) => {
        if (token === KYSELY_MODULE_CONNECTION_TOKEN()) return db;
        if (token === PageMaintenanceService) return pageMaintenance;
        return {};
      })
      .compile();
    service = module.get(TrashCleanupService);
  });

  it('routes retained trash through the fenced permanent-delete operation', async () => {
    const workspaces = {
      select: jest.fn(),
      where: jest.fn(),
      execute: jest
        .fn()
        .mockResolvedValue([{ id: workspaceId, trashRetentionDays: 30 }]),
    };
    workspaces.select.mockReturnValue(workspaces);
    workspaces.where.mockReturnValue(workspaces);
    const pages = {
      select: jest.fn(),
      where: jest.fn(),
      execute: jest.fn().mockResolvedValue([{ id: pageId, workspaceId }]),
    };
    pages.select.mockReturnValue(pages);
    pages.where.mockReturnValue(pages);
    db.selectFrom.mockImplementation((table) =>
      table === 'workspaces' ? workspaces : pages,
    );

    await service.cleanupOldTrash();

    expect(pageMaintenance.forceDelete).toHaveBeenCalledWith(pageId, workspaceId);
  });
});
