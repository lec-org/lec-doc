jest.mock('uuid', () => ({
  v7: jest.fn(),
  validate: jest.fn(() => true),
}));
jest.mock('nanoid', () => ({
  customAlphabet: jest.fn(() => jest.fn()),
}));

import { randomUUID } from 'node:crypto';
import { CamelCasePlugin, Dialect, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres = require('postgres');
import { KyselyDB } from '../../../database/types/kysely.types';
import { BacklinkRepo } from '../../../database/repos/backlink/backlink.repo';
import { BacklinkService } from './backlink.service';

const url = process.env.LEC_DOC_TEST_DATABASE_URL;

(url ? describe : describe.skip)(
  'real PostgreSQL backlink authorization pagination',
  () => {
    let db: KyselyDB;
    let service: BacklinkService;
    let workspaceId: string;
    let spaceId: string;
    let userId: string;
    let targetPageId: string;
    let allowedPageIds: string[];
    const core = { filterPages: jest.fn() };
    const local = { filterAccessiblePageIds: jest.fn() };

    beforeAll(() => {
      db = new Kysely({
        dialect: new PostgresJSDialect({
          postgres: postgres(url, { max: 4 }),
        }) as unknown as Dialect,
        plugins: [new CamelCasePlugin()],
      });
      const spaceMembers = {
        getUserSpaceIdsQuery: (memberUserId: string) =>
          db
            .selectFrom('spaceMembers')
            .select('spaceId')
            .where('userId', '=', memberUserId),
      };
      service = new BacklinkService(
        new BacklinkRepo(db, spaceMembers as any),
        local as any,
        core as any,
      );
    });

    beforeEach(async () => {
      jest.resetAllMocks();
      workspaceId = randomUUID();
      spaceId = randomUUID();
      userId = randomUUID();
      targetPageId = randomUUID();
      allowedPageIds = [randomUUID(), randomUUID()];

      await db
        .insertInto('workspaces')
        .values({ id: workspaceId, name: 'Backlink paging' })
        .execute();
      await db
        .insertInto('users')
        .values({
          id: userId,
          workspaceId,
          name: 'Reader',
          email: `${userId}@example.test`,
        })
        .execute();
      await db
        .insertInto('spaces')
        .values({
          id: spaceId,
          workspaceId,
          creatorId: userId,
          slug: `backlinks-${spaceId}`,
          name: 'Backlink space',
        })
        .execute();
      await db
        .insertInto('spaceMembers')
        .values({ id: randomUUID(), spaceId, userId, role: 'member' })
        .execute();

      const baseTime = Date.UTC(2026, 0, 1);
      const relatedPages = [
        ...Array.from({ length: 1001 }, (_, index) => ({
          id: randomUUID(),
          workspaceId,
          spaceId,
          slugId: `denied-${index}-${randomUUID()}`,
          title: `Sensitive denied backlink ${index}`,
          creatorId: userId,
          lastUpdatedById: userId,
          updatedAt: new Date(baseTime - index),
        })),
        ...allowedPageIds.map((id, index) => ({
          id,
          workspaceId,
          spaceId,
          slugId: `allowed-${index}-${id}`,
          title: `Allowed backlink ${index}`,
          creatorId: userId,
          lastUpdatedById: userId,
          updatedAt: new Date(baseTime - 1001 - index),
        })),
      ];
      await db
        .insertInto('pages')
        .values([
          {
            id: targetPageId,
            workspaceId,
            spaceId,
            slugId: `target-${targetPageId}`,
            title: 'Target',
            creatorId: userId,
            lastUpdatedById: userId,
          },
          ...relatedPages,
        ])
        .execute();
      await db
        .insertInto('backlinks')
        .values(
          relatedPages.map((page) => ({
            id: randomUUID(),
            sourcePageId: page.id,
            targetPageId,
            workspaceId,
          })),
        )
        .execute();

      const allowed = new Set(allowedPageIds);
      core.filterPages.mockImplementation(
        async (pages: Array<{ id: string }>) =>
          pages.filter((page) => allowed.has(page.id)),
      );
      local.filterAccessiblePageIds.mockImplementation(
        async ({ pageIds }: { pageIds: string[] }) => pageIds,
      );
    });

    afterEach(async () => {
      await db.deleteFrom('workspaces').where('id', '=', workspaceId).execute();
    });

    afterAll(async () => {
      await db.destroy();
    });

    it('fills and resumes a page after more than 1000 denied rows using minimal <=100-row candidates', async () => {
      const user = { id: userId, workspaceId } as any;

      const first = await service.findByPageId(targetPageId, 'incoming', user, {
        limit: 1,
      } as any);
      expect(first.items).toEqual([
        expect.objectContaining({
          id: allowedPageIds[0],
          title: 'Allowed backlink 0',
        }),
      ]);
      expect(first.meta.nextCursor).toEqual(expect.any(String));
      expect(first.meta.hasNextPage).toBe(true);

      const second = await service.findByPageId(
        targetPageId,
        'incoming',
        user,
        {
          limit: 1,
          cursor: first.meta.nextCursor,
        } as any,
      );
      expect(second.items).toEqual([
        expect.objectContaining({
          id: allowedPageIds[1],
          title: 'Allowed backlink 1',
        }),
      ]);
      expect(second.meta.nextCursor).toBeNull();

      expect(core.filterPages.mock.calls.length).toBeGreaterThan(10);
      for (const [candidates] of core.filterPages.mock.calls) {
        expect(candidates.length).toBeLessThanOrEqual(100);
        expect(
          candidates.every(
            (candidate: Record<string, unknown>) =>
              Object.keys(candidate).sort().join(',') === 'id,workspaceId',
          ),
        ).toBe(true);
      }
      expect(JSON.stringify([...first.items, ...second.items])).not.toContain(
        'Sensitive denied backlink',
      );
      await expect(service.countByPageId(targetPageId, user)).resolves.toEqual({
        incoming: 2,
        outgoing: 0,
      });
    });
  },
);
