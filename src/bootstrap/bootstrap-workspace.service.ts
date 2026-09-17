import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { Selectable, sql, Transaction } from 'kysely';
import { DbInterface } from '../database/types/db.interface';
import { Workspaces } from '../database/types/db';
import { z } from 'zod';
import { KyselyDB } from '../database/types/kysely.types';

const inputSchema = z.strictObject({
  workspaceId: z.uuid(),
  workspaceName: z.string().trim().min(1).max(100),
  organizationId: z.uuid(),
  defaultSpaceName: z.string().trim().min(1).max(100),
  defaultSpaceSlug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  ownerIssuer: z.url(),
  ownerSubject: z.string().trim().min(1).max(255),
  ownerEmail: z.email().transform((email) => email.toLowerCase()),
  ownerName: z.string().trim().min(1).max(100),
});
export type BootstrapWorkspaceInput = z.input<typeof inputSchema>;

@Injectable()
export class BootstrapWorkspaceService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly config: ConfigService,
  ) {}

  async bootstrap(raw: BootstrapWorkspaceInput) {
    const input = inputSchema.parse(raw);
    const issuer = new URL(input.ownerIssuer).href;
    const configuredOrganization = this.config.get<string>(
      'LEC_DOC_ORGANIZATION_ID',
    );
    if (configuredOrganization !== input.organizationId)
      throw new ConflictException(
        'bootstrap organization does not match LEC_DOC_ORGANIZATION_ID',
      );
    const configuredIssuer = new URL(
      this.config.getOrThrow<string>('LEC_DOC_OIDC_ISSUER'),
    ).href;
    if (configuredIssuer !== issuer)
      throw new ConflictException(
        'bootstrap issuer does not match LEC_DOC_OIDC_ISSUER',
      );

    return this.db.transaction().execute(async (trx) => {
      // Serializes two first-run CLI invocations even while no workspace row exists.
      await sql`SELECT pg_advisory_xact_lock(hashtext('lec-doc-workspace-bootstrap'))`.execute(
        trx,
      );
      const workspaces = await trx
        .selectFrom('workspaces')
        .selectAll()
        .orderBy('createdAt', 'asc')
        .execute();
      if (workspaces.length > 1)
        throw new ConflictException('Lec Doc workspace singleton violated');
      if (
        workspaces.length === 1 &&
        (workspaces[0].deletedAt || workspaces[0].id !== input.workspaceId)
      )
        throw new ConflictException(
          'existing workspace does not match bootstrap',
        );
      if (workspaces.length === 1)
        return this.verifyExisting(trx, workspaces[0], {
          ...input,
          ownerIssuer: issuer,
        });

      const workspace = await trx
        .insertInto('workspaces')
        .values({
          id: input.workspaceId,
          name: input.workspaceName,
          defaultRole: 'member',
          enforceSso: true,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      const owner = await trx
        .insertInto('users')
        .values({
          workspaceId: workspace.id,
          email: input.ownerEmail,
          name: input.ownerName,
          password: null,
          role: 'owner',
          emailVerifiedAt: new Date(),
          lastLoginAt: new Date(),
          locale: 'en-US',
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      const group = await trx
        .insertInto('groups')
        .values({
          workspaceId: workspace.id,
          creatorId: owner.id,
          name: 'Everyone',
          description: 'Group for all users in this workspace.',
          isDefault: true,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('groupUsers')
        .values({ userId: owner.id, groupId: group.id })
        .execute();
      const space = await trx
        .insertInto('spaces')
        .values({
          workspaceId: workspace.id,
          creatorId: owner.id,
          name: input.defaultSpaceName,
          slug: input.defaultSpaceSlug,
          visibility: 'private',
          defaultRole: 'writer',
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      // Only the bootstrap owner is a local space member. JIT members join the
      // default group but never inherit default-space access from local state.
      await trx
        .insertInto('spaceMembers')
        .values({
          spaceId: space.id,
          userId: owner.id,
          role: 'admin',
          addedById: owner.id,
        })
        .execute();
      await trx
        .updateTable('workspaces')
        .set({ defaultSpaceId: space.id })
        .where('id', '=', workspace.id)
        .execute();
      await trx
        .insertInto('lecIdentities')
        .values({
          workspaceId: workspace.id,
          userId: owner.id,
          issuer,
          subject: input.ownerSubject,
        })
        .execute();
      await trx
        .insertInto('lecResourceOperations')
        .values({
          id: randomUUID(),
          workspaceId: workspace.id,
          resourceKind: 'DOCMOST_SPACE',
          resourceId: space.id,
          action: 'BIND_SPACE',
          status: 'BIND_PENDING',
          registrationKey: randomUUID(),
          actorUserId: owner.id,
          actorIssuer: issuer,
          actorSubject: input.ownerSubject,
          payload: { organizationId: input.organizationId },
          availableAt: new Date(),
          updatedAt: new Date(),
        })
        .execute();
      return {
        created: true,
        workspaceId: workspace.id,
        ownerUserId: owner.id,
        groupId: group.id,
        spaceId: space.id,
        coreBinding: 'pending' as const,
      };
    });
  }

  private async verifyExisting(
    trx: Transaction<DbInterface>,
    workspace: Selectable<Workspaces>,
    input: z.output<typeof inputSchema> & { ownerIssuer: string },
  ) {
    if (
      workspace.id !== input.workspaceId ||
      workspace.name !== input.workspaceName ||
      workspace.defaultRole !== 'member' ||
      workspace.enforceSso !== true ||
      !workspace.defaultSpaceId
    )
      throw new ConflictException(
        'existing bootstrap does not match workspace',
      );
    const owner = await trx
      .selectFrom('users')
      .selectAll()
      .where('workspaceId', '=', workspace.id)
      .where('role', '=', 'owner')
      .execute();
    if (
      owner.length !== 1 ||
      owner[0].email !== input.ownerEmail ||
      owner[0].name !== input.ownerName ||
      owner[0].password !== null ||
      owner[0].deletedAt ||
      owner[0].deactivatedAt
    )
      throw new ConflictException('existing bootstrap does not match owner');
    const users = await trx
      .selectFrom('users')
      .select('id')
      .where('workspaceId', '=', workspace.id)
      .execute();
    const identities = await trx
      .selectFrom('lecIdentities')
      .selectAll()
      .where('workspaceId', '=', workspace.id)
      .execute();
    const groups = await trx
      .selectFrom('groups')
      .selectAll()
      .where('workspaceId', '=', workspace.id)
      .where('isDefault', '=', true)
      .where('deletedAt', 'is', null)
      .execute();
    const space = await trx
      .selectFrom('spaces')
      .selectAll()
      .where('id', '=', workspace.defaultSpaceId)
      .where('workspaceId', '=', workspace.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    const operation = await trx
      .selectFrom('lecResourceOperations')
      .selectAll()
      .where('workspaceId', '=', workspace.id)
      .where('resourceId', '=', workspace.defaultSpaceId)
      .where('action', '=', 'BIND_SPACE')
      .executeTakeFirst();
    if (
      users.length !== 1 ||
      identities.length !== 1 ||
      identities[0].userId !== owner[0].id ||
      identities[0].issuer !== input.ownerIssuer ||
      identities[0].subject !== input.ownerSubject ||
      groups.length !== 1 ||
      groups[0].name !== 'Everyone' ||
      !space ||
      space.name !== input.defaultSpaceName ||
      space.slug !== input.defaultSpaceSlug ||
      operation?.actorUserId !== owner[0].id ||
      operation.registrationKey === null ||
      operation.status === 'FAILED' ||
      operation.actorIssuer !== input.ownerIssuer ||
      operation.actorSubject !== input.ownerSubject ||
      (operation.payload as { organizationId?: string }).organizationId !==
        input.organizationId
    )
      throw new ConflictException('existing bootstrap does not match input');
    const memberships = await trx
      .selectFrom('spaceMembers')
      .select(['userId', 'groupId', 'role'])
      .where('spaceId', '=', space.id)
      .where('deletedAt', 'is', null)
      .execute();
    if (
      !(await trx
        .selectFrom('groupUsers')
        .select('id')
        .where('groupId', '=', groups[0].id)
        .where('userId', '=', owner[0].id)
        .executeTakeFirst()) ||
      memberships.length !== 1 ||
      memberships[0].userId !== owner[0].id ||
      memberships[0].groupId !== null ||
      memberships[0].role !== 'admin'
    )
      throw new ConflictException(
        'existing bootstrap memberships do not match',
      );
    return {
      created: false,
      workspaceId: workspace.id,
      ownerUserId: owner[0].id,
      groupId: groups[0].id,
      spaceId: space.id,
      coreBinding:
        operation.status === 'DONE' ? ('done' as const) : ('pending' as const),
    };
  }
}
