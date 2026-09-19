import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { KyselyDB } from '@docmost/db/types/kysely.types';

type Event = {
  workspaceId: string;
  resourceId: string;
  resourceVersion: string;
  effect: string;
  entitlementId: string | null;
  recipientIssuer: string | null;
  recipientSubject: string | null;
  expiresAt: Date | null;
};

@Injectable()
export class EntitlementProjectionService {
  async apply(trx: KyselyDB, event: Event) {
    if (
      !event.entitlementId ||
      !event.recipientIssuer ||
      !event.recipientSubject
    )
      throw new UnauthorizedException();
    const identity = await trx
      .selectFrom('lecIdentities')
      .select('userId')
      .where('workspaceId', '=', event.workspaceId)
      .where('issuer', '=', event.recipientIssuer)
      .where('subject', '=', event.recipientSubject)
      .executeTakeFirst();
    if (!identity) throw new UnauthorizedException();
    const version = event.resourceVersion;

    if (event.effect === 'UPSERT_GRANT') {
      await trx
        .insertInto('lecPageGrantProjections')
        .values({
          grantId: event.entitlementId,
          workspaceId: event.workspaceId,
          pageId: event.resourceId,
          userId: identity.userId,
          expiresAt: event.expiresAt,
          revokedAt: null,
          sourceVersion: version,
        })
        .onConflict((oc) =>
          oc
            .columns(['pageId', 'userId'])
            .doUpdateSet({
              grantId: event.entitlementId!,
              expiresAt: event.expiresAt,
              revokedAt: null,
              sourceVersion: version,
            })
            .where('lecPageGrantProjections.sourceVersion', '<', version),
        )
        .execute();
      return;
    }

    if (event.effect === 'REVOKE_GRANT') {
      const current = await trx
        .selectFrom('lecPageGrantProjections')
        .select(['grantId', 'sourceVersion'])
        .where('pageId', '=', event.resourceId)
        .where('userId', '=', identity.userId)
        .forUpdate()
        .executeTakeFirst();
      if (current && current.grantId !== event.entitlementId) return;
      if (current && Number(current.sourceVersion) >= Number(version)) return;
      if (current) {
        await trx
          .updateTable('lecPageGrantProjections')
          .set({ revokedAt: new Date(), sourceVersion: version })
          .where('grantId', '=', event.entitlementId)
          .where('sourceVersion', '<', version)
          .execute();
      } else {
        await trx
          .insertInto('lecPageGrantProjections')
          .values({
            grantId: event.entitlementId,
            workspaceId: event.workspaceId,
            pageId: event.resourceId,
            userId: identity.userId,
            expiresAt: null,
            revokedAt: new Date(),
            sourceVersion: version,
          })
          .execute();
      }
      return;
    }

    if (!event.expiresAt) throw new UnauthorizedException();
    const revokedAt = event.effect === 'REVOKE_ACCESS' ? new Date() : null;
    await trx
      .insertInto('lecPageAccessProjections')
      .values({
        accessRequestId: event.entitlementId,
        workspaceId: event.workspaceId,
        pageId: event.resourceId,
        userId: identity.userId,
        expiresAt: event.expiresAt,
        revokedAt,
        sourceVersion: version,
      })
      .onConflict((oc) =>
        oc
          .column('accessRequestId')
          .doUpdateSet({
            expiresAt: event.expiresAt!,
            revokedAt,
            sourceVersion: version,
          })
          .where('lecPageAccessProjections.sourceVersion', '<', version),
      )
      .execute();
    const stored = await trx
      .selectFrom('lecPageAccessProjections')
      .select(['workspaceId', 'pageId', 'userId'])
      .where('accessRequestId', '=', event.entitlementId)
      .executeTakeFirstOrThrow();
    if (
      stored.workspaceId !== event.workspaceId ||
      stored.pageId !== event.resourceId ||
      stored.userId !== identity.userId
    )
      throw new ConflictException('entitlement identity changed');
  }
}
