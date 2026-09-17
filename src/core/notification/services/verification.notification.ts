import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import {
  IApprovalRejectedNotificationJob,
  IApprovalRequestedNotificationJob,
  IPageVerifiedNotificationJob,
  IVerificationExpiringNotificationJob,
  IVerificationExpiredNotificationJob,
} from '../../../integrations/queue/constants/queue.interface';
import { NotificationService } from '../notification.service';
import { NotificationType } from '../notification.constants';
import { VerificationExpiringEmail } from '@docmost/transactional/emails/verification-expiring-email';
import { VerificationExpiredEmail } from '@docmost/transactional/emails/verification-expired-email';
import { ApprovalRequestedEmail } from '@docmost/transactional/emails/approval-requested-email';
import { ApprovalRejectedEmail } from '@docmost/transactional/emails/approval-rejected-email';
import { getPageTitle } from '../../../common/helpers';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';

@Injectable()
export class VerificationNotificationService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly notificationService: NotificationService,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
  ) {}

  private async getAlreadyNotifiedUserIds(
    pageVerificationId: string,
    type: string,
  ): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom('notifications')
      .select('userId')
      .where('pageVerificationId', '=', pageVerificationId)
      .where('type', '=', type)
      .execute();
    return new Set(rows.map((r) => r.userId));
  }

  private async filterAccessibleRecipients(
    userIds: string[],
    pageId: string,
    spaceId: string,
    workspaceId: string,
  ): Promise<string[]> {
    const coreAuthorized =
      await this.notificationService.filterRecipientsWithCoreView(
        userIds,
        pageId,
        workspaceId,
      );
    if (coreAuthorized.size === 0) return [];
    const inSpace = await this.spaceMemberRepo.getUserIdsWithSpaceAccess(
      [...coreAuthorized],
      spaceId,
    );
    if (inSpace.size === 0) return [];
    return this.pagePermissionRepo.getUserIdsWithPageAccess(pageId, [
      ...inSpace,
    ]);
  }

  private async getVerificationCandidate(verificationId: string) {
    const [verification] = await this.db
      .selectFrom('pageVerifications')
      .leftJoin(
        'pageVerifiers',
        'pageVerifiers.pageVerificationId',
        'pageVerifications.id',
      )
      .select([
        'pageVerifications.id',
        'pageVerifications.type',
        'pageVerifications.expiresAt',
        'pageVerifications.pageId',
        'pageVerifications.spaceId',
        'pageVerifications.workspaceId',
      ])
      .select((eb) =>
        eb.fn
          .agg<string[]>('array_agg', ['pageVerifiers.userId'])
          .as('verifierIds'),
      )
      .where('pageVerifications.id', '=', verificationId)
      .groupBy('pageVerifications.id')
      .execute();
    if (!verification) return null;
    const verifierIds = verification.verifierIds.filter(Boolean);
    if (verifierIds.length === 0) return null;
    const recipients = await this.filterAccessibleRecipients(
      verifierIds,
      verification.pageId,
      verification.spaceId,
      verification.workspaceId,
    );
    if (recipients.length === 0) return null;
    return { verification, recipients };
  }

  async processVerificationExpiring(
    data: IVerificationExpiringNotificationJob,
    appUrl: string,
  ) {
    const candidate = await this.getVerificationCandidate(data.verificationId);
    if (!candidate) return;

    const { verification, recipients: accessibleVerifierIds } = candidate;
    if (verification.type !== 'expiring') return;
    if (!verification.expiresAt) return;
    const expiresAtMs = new Date(verification.expiresAt).getTime();
    if (expiresAtMs <= Date.now()) return;

    const alreadyNotified = await this.getAlreadyNotifiedUserIds(
      verification.id,
      NotificationType.PAGE_VERIFICATION_EXPIRING,
    );
    const recipients = accessibleVerifierIds.filter(
      (id) => !alreadyNotified.has(id),
    );
    if (recipients.length === 0) return;

    const context = await this.getPageContext(
      verification.pageId,
      verification.spaceId,
      appUrl,
    );
    if (!context) return;

    const { pageTitle, spaceName, basePageUrl } = context;
    const expiresAtIso = new Date(verification.expiresAt).toISOString();

    for (const userId of recipients) {
      const notification = await this.notificationService.create({
        userId,
        workspaceId: verification.workspaceId,
        type: NotificationType.PAGE_VERIFICATION_EXPIRING,
        pageId: verification.pageId,
        spaceId: verification.spaceId,
        pageVerificationId: verification.id,
        data: { expiresAt: expiresAtIso },
      });

      if (!notification) continue;
      const subject = `"${pageTitle}" needs to be re-verified soon`;

      await this.notificationService.queueEmail(
        userId,
        notification.id,
        subject,
        VerificationExpiringEmail({
          pageTitle,
          spaceName,
          pageUrl: basePageUrl,
          expiresAt: new Date(verification.expiresAt).toLocaleDateString(),
        }),
      );
    }
  }

  async processVerificationExpired(
    data: IVerificationExpiredNotificationJob,
    appUrl: string,
  ) {
    const candidate = await this.getVerificationCandidate(data.verificationId);
    if (!candidate) return;

    const { verification, recipients: accessibleVerifierIds } = candidate;
    if (verification.type !== 'expiring') return;
    if (!verification.expiresAt) return;
    if (new Date(verification.expiresAt).getTime() > Date.now()) return;

    const alreadyNotified = await this.getAlreadyNotifiedUserIds(
      verification.id,
      NotificationType.PAGE_VERIFICATION_EXPIRED,
    );
    const recipients = accessibleVerifierIds.filter(
      (id) => !alreadyNotified.has(id),
    );
    if (recipients.length === 0) return;

    const context = await this.getPageContext(
      verification.pageId,
      verification.spaceId,
      appUrl,
    );
    if (!context) return;

    const { pageTitle, spaceName, basePageUrl } = context;

    for (const userId of recipients) {
      const notification = await this.notificationService.create({
        userId,
        workspaceId: verification.workspaceId,
        type: NotificationType.PAGE_VERIFICATION_EXPIRED,
        pageId: verification.pageId,
        spaceId: verification.spaceId,
        pageVerificationId: verification.id,
      });

      if (!notification) continue;
      const subject = `"${pageTitle}" verification has expired`;

      await this.notificationService.queueEmail(
        userId,
        notification.id,
        subject,
        VerificationExpiredEmail({
          pageTitle,
          spaceName,
          pageUrl: basePageUrl,
        }),
      );
    }
  }

  async processPageVerified(data: IPageVerifiedNotificationJob) {
    const { verifierIds, pageId, spaceId, workspaceId, actorId } = data;
    if (verifierIds.length === 0) return;

    const accessibleVerifierIds = await this.filterAccessibleRecipients(
      verifierIds,
      pageId,
      spaceId,
      workspaceId,
    );
    if (accessibleVerifierIds.length === 0) return;

    for (const userId of accessibleVerifierIds) {
      await this.notificationService.create({
        userId,
        workspaceId,
        type: NotificationType.PAGE_VERIFIED,
        actorId,
        pageId,
        spaceId,
      });
    }
  }

  async processApprovalRequested(
    data: IApprovalRequestedNotificationJob,
    appUrl: string,
  ) {
    const { verifierIds, pageId, spaceId, workspaceId, actorId } = data;
    if (verifierIds.length === 0) return;

    const accessibleVerifierIds = await this.filterAccessibleRecipients(
      verifierIds,
      pageId,
      spaceId,
      workspaceId,
    );
    if (accessibleVerifierIds.length === 0) return;

    const context = await this.getPageContext(pageId, spaceId, appUrl);
    if (!context) return;

    const { pageTitle, spaceName, basePageUrl } = context;
    const actorName = await this.getUserName(actorId);

    for (const userId of accessibleVerifierIds) {
      const notification = await this.notificationService.create({
        userId,
        workspaceId,
        type: NotificationType.PAGE_APPROVAL_REQUESTED,
        actorId,
        pageId,
        spaceId,
      });

      if (!notification) continue;
      const subject = `"${pageTitle}" needs your approval`;

      await this.notificationService.queueEmail(
        userId,
        notification.id,
        subject,
        ApprovalRequestedEmail({
          actorName,
          pageTitle,
          spaceName,
          pageUrl: basePageUrl,
        }),
      );
    }
  }

  async processApprovalRejected(
    data: IApprovalRejectedNotificationJob,
    appUrl: string,
  ) {
    const { pageId, spaceId, workspaceId, actorId, requestedById, comment } =
      data;

    const recipients = await this.filterAccessibleRecipients(
      [requestedById],
      pageId,
      spaceId,
      workspaceId,
    );
    if (recipients.length === 0) return;

    const context = await this.getPageContext(pageId, spaceId, appUrl);
    if (!context) return;

    const { pageTitle, spaceName, basePageUrl } = context;
    const actorName = await this.getUserName(actorId);

    const notification = await this.notificationService.create({
      userId: requestedById,
      workspaceId,
      type: NotificationType.PAGE_APPROVAL_REJECTED,
      actorId,
      pageId,
      spaceId,
    });

    if (!notification) return;
    const subject = `"${pageTitle}" was returned for revision`;

    await this.notificationService.queueEmail(
      requestedById,
      notification.id,
      subject,
      ApprovalRejectedEmail({
        actorName,
        pageTitle,
        spaceName,
        pageUrl: basePageUrl,
        comment,
      }),
    );
  }

  private async getUserName(userId: string): Promise<string> {
    const user = await this.db
      .selectFrom('users')
      .select('name')
      .where('id', '=', userId)
      .executeTakeFirst();
    return user?.name ?? 'Someone';
  }

  private async getPageContext(
    pageId: string,
    spaceId: string,
    appUrl: string,
  ) {
    const [page, space] = await Promise.all([
      this.db
        .selectFrom('pages')
        .select(['id', 'title', 'slugId'])
        .where('id', '=', pageId)
        .executeTakeFirst(),
      this.db
        .selectFrom('spaces')
        .select(['id', 'slug', 'name'])
        .where('id', '=', spaceId)
        .executeTakeFirst(),
    ]);

    if (!page || !space) return null;

    const basePageUrl = `${appUrl}/s/${space.slug}/p/${page.slugId}`;
    return {
      pageTitle: getPageTitle(page.title),
      spaceName: space.name ?? space.slug,
      basePageUrl,
    };
  }
}
