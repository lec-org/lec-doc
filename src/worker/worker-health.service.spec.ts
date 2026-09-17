import { WorkerHealthService } from './worker-health.service';

const request = async (port: number, path: string) =>
  fetch(`http://127.0.0.1:${port}${path}`);

describe('WorkerHealthService', () => {
  let service: WorkerHealthService;
  let migrations: { assertUpToDate: jest.Mock };
  let redis: { pingCheck: jest.Mock };
  let port = 39872;

  beforeEach(async () => {
    port += 1;
    migrations = { assertUpToDate: jest.fn().mockResolvedValue(undefined) };
    redis = {
      pingCheck: jest.fn().mockResolvedValue({ redis: { status: 'up' } }),
    };
    service = new WorkerHealthService(migrations as never, redis as never);
    await service.listen(port, '127.0.0.1');
  });

  afterEach(async () => {
    await service.onApplicationShutdown();
  });

  it('reports ready only when schema and Redis are ready', async () => {
    await expect(request(port, '/ready')).resolves.toMatchObject({ status: 200 });
    migrations.assertUpToDate.mockRejectedValue(new Error('pending'));
    await expect(request(port, '/ready')).resolves.toMatchObject({ status: 503 });
  });

  it('keeps liveness independent from dependencies', async () => {
    migrations.assertUpToDate.mockRejectedValue(new Error('pending'));
    await expect(request(port, '/live')).resolves.toMatchObject({ status: 200 });
  });
});
