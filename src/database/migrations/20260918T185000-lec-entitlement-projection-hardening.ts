import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE lec_page_grant_projections
      ADD CONSTRAINT lec_page_grant_projection_source_version_check
      CHECK (source_version >= 0 AND source_version < 9007199254740991);
    ALTER TABLE lec_page_access_projections
      ADD CONSTRAINT lec_page_access_projection_source_version_check
      CHECK (source_version >= 0 AND source_version < 9007199254740991)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE lec_page_access_projections
      DROP CONSTRAINT IF EXISTS lec_page_access_projection_source_version_check;
    ALTER TABLE lec_page_grant_projections
      DROP CONSTRAINT IF EXISTS lec_page_grant_projection_source_version_check
  `.execute(db);
}
