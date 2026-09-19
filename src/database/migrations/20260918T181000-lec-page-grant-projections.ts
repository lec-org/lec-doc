import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('lec_page_grant_projections')
    .addColumn('grant_id', 'uuid', (col) => col.primaryKey())
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('page_id', 'uuid', (col) =>
      col.notNull().references('pages.id').onDelete('cascade'),
    )
    .addColumn('user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('expires_at', 'timestamptz')
    .addColumn('revoked_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint('lec_page_grant_projection_page_user_unique', [
      'page_id',
      'user_id',
    ])
    .execute();

  await db.schema
    .createIndex('lec_page_grant_projection_user_idx')
    .on('lec_page_grant_projections')
    .columns(['user_id', 'created_at'])
    .execute();

  await sql`
    INSERT INTO lec_page_grant_projections (
      grant_id, workspace_id, page_id, user_id, expires_at, revoked_at
    )
    SELECT o.id, o.workspace_id, o.page_id, o.recipient_user_id,
           o.expires_at, NULL
    FROM lec_page_control_operations o
    WHERE o.action = 'GRANT_VIEW'
      AND o.status = 'DONE'
      AND o.recipient_user_id IS NOT NULL
    ON CONFLICT (page_id, user_id) DO UPDATE
      SET grant_id = EXCLUDED.grant_id,
          expires_at = EXCLUDED.expires_at,
          revoked_at = NULL
  `.execute(db);

  await sql`
    DELETE FROM page_permissions pp
    USING page_access pa, lec_page_control_operations o
    WHERE pp.page_access_id = pa.id
      AND pa.page_id = o.page_id
      AND pp.user_id = o.recipient_user_id
      AND o.action = 'GRANT_VIEW'
      AND o.status = 'DONE'
      AND o.local_page_access_id = pa.id
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('lec_page_grant_projections').execute();
}
