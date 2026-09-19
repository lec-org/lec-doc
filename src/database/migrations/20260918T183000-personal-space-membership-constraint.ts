import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    DELETE FROM space_members sm
    USING spaces s
    WHERE sm.space_id = s.id
      AND s.is_personal = true
      AND (sm.user_id IS DISTINCT FROM s.creator_id OR sm.group_id IS NOT NULL)
  `.execute(db);
  await sql`
    CREATE FUNCTION enforce_personal_space_membership() RETURNS trigger AS $$
    DECLARE creator uuid;
    BEGIN
      SELECT creator_id INTO creator FROM spaces WHERE id = NEW.space_id;
      IF EXISTS (SELECT 1 FROM spaces WHERE id = NEW.space_id AND is_personal = true)
         AND (NEW.group_id IS NOT NULL OR NEW.user_id IS DISTINCT FROM creator) THEN
        RAISE EXCEPTION 'personal spaces are creator-only' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER enforce_personal_space_membership
    BEFORE INSERT OR UPDATE OF space_id, user_id, group_id ON space_members
    FOR EACH ROW EXECUTE FUNCTION enforce_personal_space_membership();
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    DROP TRIGGER IF EXISTS enforce_personal_space_membership ON space_members;
    DROP FUNCTION IF EXISTS enforce_personal_space_membership();
  `.execute(db);
}
