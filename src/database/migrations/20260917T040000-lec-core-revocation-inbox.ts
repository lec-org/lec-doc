import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('lec_core_revocation_inbox')
    .addColumn('event_id', 'uuid', (col) => col.primaryKey())
    .addColumn('workspace_id', 'uuid', (col) => col.notNull())
    .addColumn('resource_kind', 'varchar(32)', (col) => col.notNull())
    .addColumn('resource_id', 'uuid', (col) => col.notNull())
    .addColumn('resource_version', 'bigint', (col) => col.notNull())
    .addColumn('published_at', 'timestamptz')
    .addColumn('superseded_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      'lec_core_revocation_inbox_kind_check',
      sql`resource_kind IN ('DOCMOST_SPACE', 'DOCMOST_PAGE')`,
    )
    .addCheckConstraint(
      'lec_core_revocation_inbox_version_check',
      sql`resource_version > 0 AND resource_version < 9007199254740991`,
    )
    .execute();

  await db.schema
    .createIndex('lec_core_revocation_inbox_pending_idx')
    .on('lec_core_revocation_inbox')
    .column('created_at')
    .where(sql.ref('published_at'), 'is', null)
    .where(sql.ref('superseded_at'), 'is', null)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('lec_core_revocation_inbox').execute();
}
