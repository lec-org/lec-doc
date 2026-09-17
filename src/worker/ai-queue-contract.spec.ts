import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = join(__dirname, '..');
const read = (path: string) => readFileSync(join(src, path), 'utf8');

const productionSources = [
  'collaboration/extensions/persistence.extension.ts',
  'core/page/services/page.service.ts',
  'core/page/services/page-maintenance.service.ts',
  'core/workspace/services/workspace.service.ts',
  'database/database.module.ts',
  'integrations/queue/constants/queue.constants.ts',
  'integrations/queue/queue.module.ts',
];

describe('Community background indexing contract', () => {
  it('does not enqueue unsupported AI/index jobs without a Community processor', () => {
    const source = productionSources.map(read).join('\n');

    expect(source).not.toMatch(/AI_QUEUE|aiQueue/);
    expect(source).not.toMatch(
      /PAGE_(?:CREATED|CONTENT_UPDATED|MOVED_TO_SPACE|SOFT_DELETED|RESTORED|DELETED)|WORKSPACE_(?:CREATE|DELETE|RESET)_EMBEDDINGS|(?:GENERATE|DELETE)_PAGE_EMBEDDINGS/,
    );
  });

  it('keeps physical page deletion bound to the durable deleted-tree lifecycle check', () => {
    const maintenance = read('core/page/services/page-maintenance.service.ts');

    expect(maintenance).toContain('this.lifecycle.requireDeletedTree(');
    expect(maintenance).not.toContain('EventName.PAGE_DELETED');
    expect(maintenance.indexOf('this.lifecycle.requireDeletedTree(')).toBeLessThan(
      maintenance.indexOf("this.db.deleteFrom('pages')"),
    );
  });
});
