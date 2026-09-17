import { MigrationService } from './migration.service';

jest.mock('kysely', () => {
  const actual = jest.requireActual('kysely');
  return {
    ...actual,
    Migrator: jest.fn(),
  };
});

import { Migrator } from 'kysely';

const createService = (migrations: Array<{ name: string; executedAt?: Date }>) => {
  (Migrator as jest.MockedClass<typeof Migrator>).mockImplementation(
    () =>
      ({
        getMigrations: jest.fn().mockResolvedValue(migrations),
      }) as never,
  );
  return new MigrationService({} as never);
};

describe('MigrationService schema readiness', () => {
  it('accepts an up-to-date schema', async () => {
    await expect(
      createService([{ name: '001', executedAt: new Date() }]).assertUpToDate(),
    ).resolves.toBeUndefined();
  });

  it('rejects pending migrations without applying them', async () => {
    await expect(
      createService([{ name: '002' }]).assertUpToDate(),
    ).rejects.toThrow('Pending database migrations: 002');
  });
});
