jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (value: string) => value,
}));
jest.mock('p-limit', () => ({
  __esModule: true,
  default: () => (work: () => unknown) => work(),
}));

import { FileImportTaskService } from './file-import-task.service';

const task = {
  id: '10000000-0000-4000-8000-000000000001',
  creatorId: '20000000-0000-4000-8000-000000000001',
  workspaceId: '30000000-0000-4000-8000-000000000001',
  spaceId: '40000000-0000-4000-8000-000000000001',
  filePath: 'imports/archive.zip',
  status: 'processing',
  source: 'generic',
};

function query(value: unknown) {
  const chain: any = {
    selectAll: jest.fn(() => chain),
    select: jest.fn(() => chain),
    where: jest.fn(() => chain),
    executeTakeFirst: jest.fn().mockResolvedValue(value),
  };
  return chain;
}

describe('ZIP import execution-time authorization', () => {
  it('rechecks Core before reading the queued archive', async () => {
    const storage = { readStream: jest.fn() };
    const authorization = {
      check: jest.fn().mockResolvedValue([
        {
          resource_id: task.spaceId,
          capability: 'CREATE',
          allowed: false,
        },
      ]),
      deny: jest.fn(() => {
        throw new Error('denied');
      }),
    };
    const users = {
      findById: jest.fn().mockResolvedValue({
        id: task.creatorId,
        workspaceId: task.workspaceId,
      }),
    };
    const ability = {
      createForUser: jest.fn().mockResolvedValue({ cannot: () => false }),
    };
    const db = { selectFrom: jest.fn(() => query(task)) };
    const service = new FileImportTaskService(
      storage as any,
      {} as any,
      {} as any,
      {} as any,
      db as any,
      {} as any,
      {} as any,
      users as any,
      ability as any,
      authorization as any,
      {} as any,
    );

    await expect(service.processZIpImport(task.id)).rejects.toThrow('denied');
    expect(authorization.check).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.creatorId }),
      task.workspaceId,
      [
        {
          resource_kind: 'DOCMOST_SPACE',
          resource_id: task.spaceId,
          capability: 'CREATE',
        },
      ],
    );
    expect(storage.readStream).not.toHaveBeenCalled();
  });
});
