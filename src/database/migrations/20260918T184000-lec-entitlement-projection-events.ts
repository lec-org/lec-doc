import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('lec_core_revocation_inbox')
    .addColumn('effect', 'varchar(32)', (col) =>
      col.notNull().defaultTo('NONE'),
    )
    .addColumn('entitlement_id', 'uuid')
    .addColumn('recipient_issuer', 'text')
    .addColumn('recipient_subject', 'text')
    .addColumn('expires_at', 'timestamptz')
    .addColumn('projected_at', 'timestamptz')
    .execute();

  await db.schema
    .alterTable('lec_page_grant_projections')
    .addColumn('source_version', 'bigint', (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema
    .alterTable('lec_page_access_projections')
    .addColumn('source_version', 'bigint', (col) => col.notNull().defaultTo(0))
    .execute();
  await sql`
    UPDATE lec_core_revocation_inbox
    SET projected_at = COALESCE(projected_at, superseded_at),
        published_at = COALESCE(published_at, superseded_at)
    WHERE superseded_at IS NOT NULL
  `.execute(db);
  await sql`
    ALTER TABLE lec_core_revocation_inbox
    ADD CONSTRAINT lec_core_revocation_inbox_effect_check CHECK (
      (effect = 'NONE'
        AND entitlement_id IS NULL
        AND recipient_issuer IS NULL
        AND recipient_subject IS NULL
        AND expires_at IS NULL)
      OR
      (effect = 'UPSERT_GRANT'
        AND entitlement_id IS NOT NULL
        AND recipient_issuer IS NOT NULL
        AND recipient_subject IS NOT NULL)
      OR
      (effect = 'REVOKE_GRANT'
        AND entitlement_id IS NOT NULL
        AND recipient_issuer IS NOT NULL
        AND recipient_subject IS NOT NULL
        AND expires_at IS NULL)
      OR
      (effect IN ('UPSERT_ACCESS', 'REVOKE_ACCESS')
        AND entitlement_id IS NOT NULL
        AND recipient_issuer IS NOT NULL
        AND recipient_subject IS NOT NULL
        AND expires_at IS NOT NULL)
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('lec_page_access_projections')
    .dropColumn('source_version')
    .execute();
  await db.schema
    .alterTable('lec_page_grant_projections')
    .dropColumn('source_version')
    .execute();
  await db.schema
    .alterTable('lec_core_revocation_inbox')
    .dropConstraint('lec_core_revocation_inbox_effect_check')
    .execute();
  await db.schema
    .alterTable('lec_core_revocation_inbox')
    .dropColumn('projected_at')
    .dropColumn('expires_at')
    .dropColumn('recipient_subject')
    .dropColumn('recipient_issuer')
    .dropColumn('entitlement_id')
    .dropColumn('effect')
    .execute();
}
