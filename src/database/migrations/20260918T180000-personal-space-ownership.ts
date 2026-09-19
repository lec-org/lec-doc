import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('spaces')
    .addColumn('is_default_personal', 'boolean', (col) =>
      col.notNull().defaultTo(false),
    )
    .execute();

  await sql`
    UPDATE spaces
    SET is_default_personal = true
    WHERE is_personal = true AND deleted_at IS NULL
  `.execute(db);
  const orphan = await sql<{ id: string }>`
    SELECT id FROM spaces
    WHERE is_personal = true AND creator_id IS NULL
    LIMIT 1
  `.execute(db);
  if (orphan.rows.length)
    throw new Error('Cannot migrate personal space without creator');
  await sql`
    INSERT INTO spaces (
      id, name, description, slug, creator_id, workspace_id,
      is_personal, is_default_personal
    )
    SELECT
      gen_uuid_v7(), COALESCE(NULLIF(BTRIM(u.name), ''), 'Personal'), '',
      'personal-' || replace(gen_uuid_v7()::text, '-', ''),
      u.id, u.workspace_id, true, true
    FROM users u
    JOIN lec_identities i
      ON i.workspace_id = u.workspace_id AND i.user_id = u.id
    WHERE u.workspace_id IS NOT NULL
      AND u.deleted_at IS NULL
      AND u.deactivated_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM spaces s
        WHERE s.workspace_id = u.workspace_id
          AND s.creator_id = u.id
          AND s.is_default_personal = true
          AND s.deleted_at IS NULL
      )
  `.execute(db);
  await sql`
    INSERT INTO lec_resource_operations (
      id, workspace_id, resource_kind, resource_id, action, status,
      registration_key, actor_user_id, actor_issuer, actor_subject,
      payload, available_at, updated_at
    )
    SELECT
      gen_uuid_v7(), s.workspace_id, 'DOCMOST_SPACE', s.id, 'BIND_SPACE',
      'BIND_PENDING', gen_uuid_v7(), s.creator_id, i.issuer, i.subject,
      jsonb_build_object('organizationId', w.organization_id, 'personal', true),
      now(), now()
    FROM spaces s
    JOIN lec_identities i
      ON i.workspace_id = s.workspace_id AND i.user_id = s.creator_id
    JOIN (
      SELECT workspace_id,
             MAX(payload->>'organizationId')::uuid AS organization_id
      FROM lec_resource_operations
      WHERE action = 'BIND_SPACE' AND payload ? 'organizationId'
      GROUP BY workspace_id
      HAVING COUNT(DISTINCT payload->>'organizationId') = 1
    ) w ON w.workspace_id = s.workspace_id
    WHERE s.is_default_personal = true
      AND s.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM lec_resource_operations o
        WHERE o.workspace_id = s.workspace_id
          AND o.resource_id = s.id
          AND o.action = 'BIND_SPACE'
      )
  `.execute(db);
  const unbound = await sql<{ id: string }>`
    SELECT s.id
    FROM spaces s
    JOIN lec_identities i
      ON i.workspace_id = s.workspace_id AND i.user_id = s.creator_id
    WHERE s.is_default_personal = true
      AND s.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM lec_resource_operations o
        WHERE o.workspace_id = s.workspace_id
          AND o.resource_id = s.id
          AND o.action = 'BIND_SPACE'
      )
    LIMIT 1
  `.execute(db);
  if (unbound.rows.length)
    throw new Error('Cannot derive Core organization for personal space bind');
  await sql`
    DELETE FROM space_members sm
    USING spaces s
    WHERE sm.space_id = s.id
      AND s.is_personal = true
      AND (sm.user_id IS DISTINCT FROM s.creator_id OR sm.group_id IS NOT NULL)
  `.execute(db);
  await sql`
    UPDATE public_spaces ps
    SET enabled = false, updated_at = now()
    FROM spaces s
    WHERE ps.space_id = s.id AND s.is_personal = true
  `.execute(db);
  await sql`
    INSERT INTO space_members (space_id, user_id, role, added_by_id)
    SELECT s.id, s.creator_id, 'admin', s.creator_id
    FROM spaces s
    WHERE s.is_default_personal = true
      AND s.deleted_at IS NULL
    ON CONFLICT (space_id, user_id) DO NOTHING
  `.execute(db);
  await sql`
    UPDATE lec_resource_operations o
    SET payload = o.payload || jsonb_build_object(
      'personal', COALESCE(s.is_personal, false)
    )
    FROM spaces s
    WHERE o.action = 'BIND_SPACE'
      AND o.workspace_id = s.workspace_id
      AND o.resource_id = s.id
      AND NOT (o.payload ? 'personal')
  `.execute(db);
  await sql`
    ALTER TABLE spaces
    ADD CONSTRAINT spaces_default_personal_check
    CHECK (NOT is_default_personal OR is_personal),
    ADD CONSTRAINT spaces_personal_creator_check
    CHECK (NOT is_personal OR creator_id IS NOT NULL)
  `.execute(db);
  await db.schema
    .dropIndex('spaces_personal_creator_unique')
    .ifExists()
    .execute();
  await sql`
    CREATE UNIQUE INDEX spaces_default_personal_creator_unique
    ON spaces (workspace_id, creator_id)
    WHERE is_default_personal = true AND deleted_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  const duplicate = await sql<{ creatorId: string }>`
    SELECT creator_id AS "creatorId"
    FROM spaces
    WHERE is_personal = true AND deleted_at IS NULL
    GROUP BY creator_id
    HAVING COUNT(*) > 1
    LIMIT 1
  `.execute(db);
  if (duplicate.rows.length)
    throw new Error(
      'Cannot restore one-personal-space constraint while users have multiple personal spaces',
    );
  await db.schema
    .dropIndex('spaces_default_personal_creator_unique')
    .ifExists()
    .execute();
  await sql`
    ALTER TABLE spaces
      DROP CONSTRAINT spaces_default_personal_check,
      DROP CONSTRAINT spaces_personal_creator_check
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX spaces_personal_creator_unique
    ON spaces (creator_id)
    WHERE is_personal = true AND deleted_at IS NULL
  `.execute(db);
  await db.schema
    .alterTable('spaces')
    .dropColumn('is_default_personal')
    .execute();
}
