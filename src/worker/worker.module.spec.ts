import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const src = join(__dirname, '..');
const read = (path: string) => readFileSync(join(src, path), 'utf8');
const typescriptFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? typescriptFiles(path)
      : entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
        ? [path]
        : [];
  });

describe('process role providers', () => {
  it('registers the complete BullMQ processor inventory only in WorkerModule', () => {
    const processors = typescriptFiles(src).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      const match = source.match(/@Processor\([^)]*\)[\s\S]*?export class (\w+)/);
      return match ? [match[1]] : [];
    });
    const worker = read('worker/worker.module.ts');
    const nonWorkerModules = typescriptFiles(src)
      .filter(
        (path) =>
          path.endsWith('.module.ts') &&
          path !== join(src, 'worker/worker.module.ts'),
      )
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');

    expect(processors.sort()).toEqual([
      'AttachmentProcessor',
      'EmailProcessor',
      'FileTaskProcessor',
      'GeneralQueueProcessor',
      'HistoryProcessor',
      'NotificationProcessor',
    ]);
    for (const processor of processors) {
      expect(worker).toContain(processor);
      expect(nonWorkerModules).not.toMatch(
        new RegExp(`providers:\\s*\\[[^\\]]*${processor}`),
      );
    }
  });

  it('keeps schedulers and the collaboration listener in their owning roles', () => {
    expect(read('app.module.ts')).not.toContain('ScheduleModule.forRoot()');
    expect(read('collaboration/server/collab-app.module.ts')).not.toContain(
      'ScheduleModule.forRoot()',
    );
    expect(read('worker/worker.module.ts')).toContain('ScheduleModule.forRoot()');
    expect(read('worker/worker.module.ts')).not.toMatch(
      /AppModule|CollabAppModule|WsModule|CollaborationModule/,
    );
    expect(read('collaboration/server/collab-app.module.ts')).toContain(
      "handleUpgrade('/collab'",
    );
    expect(read('collaboration/server/collab-app.module.ts')).toContain(
      'HealthModule',
    );
    expect(read('worker/worker.module.ts')).toContain('WorkerHealthService');
    expect(read('database/database.module.ts')).toContain(
      'assertUpToDate()',
    );
    expect(read('database/database.module.ts')).not.toContain(
      'migrateToLatest()',
    );
    expect(read('collaboration/collaboration.module.ts')).not.toContain(
      'handleUpgrade(',
    );
  });

  it('exports the Redis readiness indicator to the worker role', () => {
    expect(read('integrations/health/health.module.ts')).toContain(
      'exports: [RedisHealthIndicator]',
    );
  });
});
