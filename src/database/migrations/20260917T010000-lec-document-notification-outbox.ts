import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('lec_document_notification_outbox')
    .addColumn('notification_id', 'uuid', (col) =>
      col.primaryKey().references('notifications.id').onDelete('cascade'),
    )
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('available_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('lease_until', 'timestamptz')
    .addColumn('completed_at', 'timestamptz')
    .addColumn('suppressed_at', 'timestamptz')
    .addColumn('last_error', 'varchar(500)')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      'lec_document_notification_outbox_attempts_check',
      sql`attempts >= 0`,
    )
    .execute();

  await db.schema
    .createIndex('lec_document_notification_outbox_pending_idx')
    .on('lec_document_notification_outbox')
    .columns(['available_at', 'created_at'])
    .where(sql.ref('completed_at'), 'is', null)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('lec_document_notification_outbox').execute();
}
