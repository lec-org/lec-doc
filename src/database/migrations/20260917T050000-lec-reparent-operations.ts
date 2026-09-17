import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE lec_resource_operations
      DROP CONSTRAINT lec_resource_operations_action_check,
      ADD CONSTRAINT lec_resource_operations_action_check
      CHECK (action IN ('BIND_SPACE', 'CREATE_PAGE', 'DELETE_TREE', 'RESTORE_TREE', 'REPARENT_PAGE'))
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX lec_resource_operations_one_reparent
      ON lec_resource_operations (workspace_id, resource_id)
      WHERE action = 'REPARENT_PAGE' AND status NOT IN ('DONE', 'FAILED')
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS lec_resource_operations_one_reparent`.execute(
    db,
  );
  await sql`
    ALTER TABLE lec_resource_operations
      DROP CONSTRAINT lec_resource_operations_action_check,
      ADD CONSTRAINT lec_resource_operations_action_check
      CHECK (action IN ('BIND_SPACE', 'CREATE_PAGE', 'DELETE_TREE', 'RESTORE_TREE'))
  `.execute(db);
}
