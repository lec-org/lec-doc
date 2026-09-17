import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EmailProcessor } from './email.processor';
import { MailService } from '../mail.service';

const notificationId = '31bd1544-2b8e-4b38-8aec-b838ff7453b8';
const message = {
  to: 'recipient@example.test',
  subject: 'already-rendered sensitive title',
  html: '<p>already-rendered sensitive comment</p>',
  notificationId,
};
const target = {
  userId: 'e2279aa5-b0c3-482e-816a-e0dd2ade7c37',
  workspaceId: '1c312fef-c48f-4d57-bdd6-e5694315d702',
  userDeactivatedAt: null,
  userDeletedAt: null,
  pageId: 'fe96e188-64d1-4ab0-9e54-ea3eff745572',
  pageDeletedAt: null,
};

function query(result: unknown) {
  const chain: any = {
    innerJoin: jest.fn(() => chain),
    select: jest.fn(() => chain),
    where: jest.fn(() => chain),
    executeTakeFirst: jest.fn().mockResolvedValue(result),
  };
  return chain;
}

function processor(requirePage: jest.Mock) {
  const driver = { sendMail: jest.fn() };
  const mailService = new MailService(
    driver as any,
    {
      getMailBlockedRecipientDomains: () => [],
      getMailFromAddress: () => 'mail@example.test',
      getMailFromName: () => 'LEC',
    } as any,
    {} as any,
  );
  const notificationRepo = { markAsEmailed: jest.fn() };
  const db = { selectFrom: jest.fn(() => query(target)) };
  return {
    instance: new EmailProcessor(
      mailService as any,
      notificationRepo as any,
      db as any,
      { requirePage } as any,
    ),
    driver,
    notificationRepo,
  };
}

describe('EmailProcessor delivery-time authorization', () => {
  it('suppresses an email when VIEW was revoked after enqueue', async () => {
    const { instance, driver, notificationRepo } = processor(
      jest.fn().mockRejectedValue(new ForbiddenException()),
    );

    await expect(
      instance.process({ data: message } as any),
    ).resolves.toBeUndefined();

    expect(driver.sendMail).not.toHaveBeenCalled();
    expect(notificationRepo.markAsEmailed).not.toHaveBeenCalled();
  });

  it('throws when Core is unavailable before delivery', async () => {
    const outage = new ServiceUnavailableException();
    const { instance, driver, notificationRepo } = processor(
      jest.fn().mockRejectedValue(outage),
    );

    await expect(instance.process({ data: message } as any)).rejects.toBe(
      outage,
    );

    expect(driver.sendMail).not.toHaveBeenCalled();
    expect(notificationRepo.markAsEmailed).not.toHaveBeenCalled();
  });
});
