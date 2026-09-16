import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('lec_resource_operations')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('resource_kind', 'varchar(32)', (col) => col.notNull())
    .addColumn('resource_id', 'uuid', (col) => col.notNull())
    .addColumn('action', 'varchar(32)', (col) => col.notNull())
    .addColumn('status', 'varchar(40)', (col) => col.notNull())
    .addColumn('registration_key', 'uuid')
    .addColumn('source_operation_id', 'uuid')
    .addColumn('actor_user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('actor_issuer', 'varchar(2048)', (col) => col.notNull())
    .addColumn('actor_subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('payload', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
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
      'lec_resource_operations_kind_check',
      sql`resource_kind IN ('DOCMOST_SPACE', 'DOCMOST_PAGE')`,
    )
    .addCheckConstraint(
      'lec_resource_operations_action_check',
      sql`action IN ('BIND_SPACE', 'CREATE_PAGE', 'DELETE_TREE', 'RESTORE_TREE')`,
    )
    .execute();

  await sql`
    CREATE UNIQUE INDEX lec_resource_operations_space_binding
    ON lec_resource_operations (workspace_id, resource_id)
    WHERE action = 'BIND_SPACE'
  `.execute(db);
  await sql`
    CREATE INDEX lec_resource_operations_pending
    ON lec_resource_operations (available_at, created_at)
    WHERE status <> 'DONE'
  `.execute(db);
  await sql`
    CREATE INDEX lec_resource_operations_resource
    ON lec_resource_operations (workspace_id, resource_kind, resource_id, created_at DESC)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('lec_resource_operations').execute();
}
