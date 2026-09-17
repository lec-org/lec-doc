import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE FUNCTION lec_search_unaccent(text) RETURNS text
    AS $$
      SELECT public.unaccent('public.unaccent'::regdictionary, $1);
    $$ LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS pages_text_content_trgm_idx
    ON pages USING gin (
      lower(lec_search_unaccent(substring(coalesce(text_content, ''), 1, 1000000))) gin_trgm_ops
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('pages_text_content_trgm_idx').execute();
  await sql`DROP FUNCTION IF EXISTS lec_search_unaccent(text)`.execute(db);
}
