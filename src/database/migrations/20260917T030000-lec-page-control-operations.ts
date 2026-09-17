import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('lec_page_control_operations')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('page_id', 'uuid', (col) => col.notNull())
    .addColumn('space_id', 'uuid', (col) => col.notNull())
    .addColumn('action', 'varchar(32)', (col) => col.notNull())
    .addColumn('status', 'varchar(32)', (col) => col.notNull())
    .addColumn('actor_user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('actor_issuer', 'varchar(2048)', (col) => col.notNull())
    .addColumn('actor_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('recipient_user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('recipient_issuer', 'varchar(2048)', (col) => col.notNull())
    .addColumn('recipient_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('local_page_access_id', 'uuid')
    .addColumn('expected_version', 'bigint', (col) => col.notNull())
    .addColumn('expires_at', 'timestamptz')
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('available_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('lease_until', 'timestamptz')
    .addColumn('last_error_code', 'varchar(64)')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      'lec_page_control_operations_action_check',
      sql`action IN ('GRANT_VIEW')`,
    )
    .addCheckConstraint(
      'lec_page_control_operations_status_check',
      sql`status IN ('CORE_PENDING', 'LOCAL_PENDING', 'NOTIFICATION_PENDING', 'DONE', 'FAILED')`,
    )
    .addCheckConstraint(
      'lec_page_control_operations_expected_version_check',
      sql`expected_version > 0 AND expected_version < 9007199254740991`,
    )
    .execute();

  await db.schema
    .createIndex('lec_page_control_operations_pending_idx')
    .on('lec_page_control_operations')
    .columns(['available_at', 'created_at'])
    .where(sql.ref('status'), 'not in', ['DONE', 'FAILED'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('lec_page_control_operations').execute();
}
