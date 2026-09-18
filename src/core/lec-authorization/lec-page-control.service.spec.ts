jest.mock('uuid', () => ({ validate: jest.fn(() => true) }));

import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { LecPageControlService } from './lec-page-control.service';

const page = {
  id: '10000000-0000-4000-8000-000000000001',
  workspaceId: '20000000-0000-4000-8000-000000000001',
  spaceId: '30000000-0000-4000-8000-000000000001',
  deletedAt: null,
};
const actor = {
  id: '40000000-0000-4000-8000-000000000001',
  workspaceId: page.workspaceId,
};
const recipient = {
  id: '50000000-0000-4000-8000-000000000001',
  workspaceId: page.workspaceId,
};
const dto = {
  pageId: page.id,
  subjectIssuer: 'https://id.example.test/oidc',
  subject: 'recipient-subject',
  operationId: '60000000-0000-4000-8000-000000000001',
  expectedVersion: 2,
};

function service(
  send = jest.fn().mockResolvedValue({ data: { resource_version: 3 } }),
) {
  const notifications = {
    create: jest.fn().mockResolvedValue({ id: dto.operationId }),
  };
  const row = {
    id: dto.operationId,
    workspaceId: page.workspaceId,
    pageId: page.id,
    spaceId: page.spaceId,
    action: 'GRANT_VIEW',
    status: 'CORE_PENDING',
    actorUserId: actor.id,
    actorIssuer: 'https://id.example.test/oidc',
    actorSubject: 'actor-subject',
    recipientUserId: recipient.id,
    recipientIssuer: dto.subjectIssuer,
    recipientSubject: dto.subject,
    expectedVersion: String(dto.expectedVersion),
    expiresAt: null,
  };
  const query: any = {
    innerJoin: jest.fn(() => query),
    select: jest.fn(() => query),
    selectAll: jest.fn(() => query),
    where: jest.fn(() => query),
    set: jest.fn(() => query),
    values: jest.fn(() => query),
    onConflict: jest.fn((callback) => {
      const conflict = {
        column: jest.fn(() => ({
          doNothing: jest.fn(),
          doUpdateSet: jest.fn(),
        })),
        columns: jest.fn(() => ({ doUpdateSet: jest.fn() })),
      };
      callback(conflict);
      return query;
    }),
    returning: jest.fn(() => query),
    executeTakeFirstOrThrow: jest.fn().mockResolvedValue({ id: 'page-access' }),
    returningAll: jest.fn(() => query),
    executeTakeFirst: jest.fn().mockResolvedValue(row),
    execute: jest.fn().mockResolvedValue([]),
  };
  const db: any = {
    insertInto: jest.fn(() => query),
    selectFrom: jest.fn(() => query),
    updateTable: jest.fn(() => query),
  };
  db.transaction = jest.fn(() => ({
    execute: (callback: (trx: any) => unknown) => callback(db),
  }));
  return {
    control: new LecPageControlService(
      { findAuthorizationSubject: jest.fn().mockResolvedValue(page) } as any,
      {
        principal: jest
          .fn()
          .mockResolvedValue({
            type: 'OIDC',
            issuer: 'https://id.example.test/oidc',
            subject: 'actor-subject',
          }),
        deny: jest.fn(),
      } as any,
      { send } as any,
      notifications as any,
      db as any,
    ),
    send,
    notifications,
  };
}

describe('Lec page control wrappers', () => {
  const principal = {
    type: 'OIDC' as const,
    issuer: 'https://id.example.test/oidc',
    subject: 'actor-subject',
  };
  const coreResource = {
    data: {
      workspace_id: page.workspaceId,
      resource_kind: 'DOCMOST_PAGE',
      resource_id: page.id,
      organization_id: '70000000-0000-4000-8000-000000000001',
      parent_kind: 'DOCMOST_SPACE',
      parent_id: page.spaceId,
      owner_user_id: actor.id,
      classification: 4,
      state: 'ACTIVE',
      resource_version: 3,
      registration_key: '80000000-0000-4000-8000-000000000001',
      created_at: '2026-09-17T00:00:00.000Z',
      updated_at: '2026-09-17T00:00:00.000Z',
    },
  };
  const accessRequest = {
    data: {
      id: '90000000-0000-4000-8000-000000000001',
      workspace_id: page.workspaceId,
      resource_kind: 'DOCMOST_PAGE',
      resource_id: page.id,
      user_id: actor.id,
      status: 'PENDING',
      reason: 'Need collaboration access',
      reviewed_by: null,
      expires_at: null,
      created_at: '2026-09-17T00:00:00.000Z',
      updated_at: '2026-09-17T00:00:00.000Z',
    },
  };
  const commands = [
    [
      'classify',
      'doc-control/classify',
      { ...dto, classification: 4 },
      { classification: 4 },
      coreResource,
    ],
    [
      'transferOwner',
      'doc-control/transfer-owner',
      { ...dto, ownerUserId: recipient.id },
      { owner_user_id: recipient.id },
      coreResource,
    ],
    [
      'revokeGrant',
      'doc-control/revoke-grant',
      { ...dto, grantId: recipient.id },
      { grant_id: recipient.id },
      coreResource,
    ],
    [
      'requestAccess',
      'doc-control/request-access',
      { pageId: 'page-slug-id', reason: accessRequest.data.reason },
      { reason: accessRequest.data.reason },
      accessRequest,
    ],
    [
      'reviewAccess',
      'doc-control/review-access',
      {
        ...dto,
        accessRequestId: accessRequest.data.id,
        decision: 'APPROVE',
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      },
      {
        access_request_id: accessRequest.data.id,
        decision: 'APPROVE',
        expires_at: '2030-01-01T00:00:00.000Z',
      },
      coreResource,
    ],
    [
      'revokeAccess',
      'doc-control/revoke-access',
      { ...dto, accessRequestId: accessRequest.data.id },
      { access_request_id: accessRequest.data.id },
      coreResource,
    ],
  ] as const;

  function wrapper(send: jest.Mock) {
    const pages = {
      findAuthorizationSubject: jest.fn().mockResolvedValue(page),
    };
    const authorization = {
      principal: jest.fn().mockResolvedValue(principal),
      deny: jest.fn(() => {
        throw new Error('denied');
      }),
    };
    return {
      control: new LecPageControlService(
        pages as any,
        authorization as any,
        { send } as any,
        {} as any,
        {} as any,
      ),
      pages,
      authorization,
    };
  }

  it.each(commands)(
    'sends %s through the strict Core command contract',
    async (method, path, input, command, response) => {
      const send = jest.fn().mockResolvedValue(response);
      const fixture = wrapper(send);

      await expect(
        (fixture.control[method] as any)(actor, input),
      ).resolves.toEqual(response.data);
      expect(fixture.pages.findAuthorizationSubject).toHaveBeenCalledWith(
        input.pageId,
      );
      expect(fixture.authorization.principal).toHaveBeenCalledWith(
        actor,
        page.workspaceId,
      );
      expect(send).toHaveBeenCalledWith(
        path,
        expect.objectContaining({
          workspace_id: page.workspaceId,
          principal,
          resource_kind: 'DOCMOST_PAGE',
          resource_id: page.id,
          ...('expectedVersion' in input
            ? {
                expected_version: input.expectedVersion,
                operation_id: input.operationId,
              }
            : {}),
          ...command,
        }),
        expect.anything(),
      );
    },
  );

  it.each(commands)(
    'fails closed with a stable outage for %s',
    async (method, _path, input) => {
      const send = jest.fn().mockRejectedValue(new Error('socket detail'));
      const fixture = wrapper(send);

      const promise = (fixture.control[method] as any)(actor, input);
      await expect(promise).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(promise).rejects.toMatchObject({
        response: {
          code: 'DOC_AUTHORIZATION_UNAVAILABLE',
          message: '文档授权暂不可用，请稍后重试',
        },
      });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it.each(commands)(
    'preserves the stable Core denial for %s',
    async (method, _path, input) => {
      const denied = new ForbiddenException({ code: 'DOC_FORBIDDEN' });
      const fixture = wrapper(jest.fn().mockRejectedValue(denied));

      await expect((fixture.control[method] as any)(actor, input)).rejects.toBe(
        denied,
      );
    },
  );
});

describe('Lec page grant control', () => {
  it('creates the recipient notification only after Core grants VIEW', async () => {
    const fixture = service();

    await fixture.control.grantView(actor as any, dto);

    expect(fixture.send).toHaveBeenCalledWith(
      'doc-control/grant',
      expect.objectContaining({
        subject_type: 'USER',
        subject_issuer: dto.subjectIssuer,
        subject: dto.subject,
        operation_id: dto.operationId,
        expected_version: dto.expectedVersion,
      }),
      expect.anything(),
    );
    expect(fixture.notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: dto.operationId,
        userId: recipient.id,
        actorId: actor.id,
        pageId: page.id,
        type: 'page.permission_granted',
      }),
    );
  });

  it('has no notification side effect when Core rejects or is unavailable', async () => {
    const denied = service(
      jest.fn().mockRejectedValue(new Error('Core unavailable')),
    );

    await expect(denied.control.grantView(actor as any, dto)).rejects.toThrow(
      'Core unavailable',
    );
    expect(denied.notifications.create).not.toHaveBeenCalled();
  });
});
