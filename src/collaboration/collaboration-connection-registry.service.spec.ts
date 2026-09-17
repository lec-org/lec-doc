import { CollaborationConnectionRegistry } from './collaboration-connection-registry.service';

const workspaceId = '10000000-0000-4000-8000-000000000001';
const spaceId = '20000000-0000-4000-8000-000000000001';
const page1 = '30000000-0000-4000-8000-000000000001';
const page2 = '30000000-0000-4000-8000-000000000002';
const page3 = '30000000-0000-4000-8000-000000000003';

function setup() {
  let onMessage: (channel: string, payload: string) => void;
  const subscriber = {
    on: jest.fn((_event, callback) => {
      onMessage = callback;
    }),
    subscribe: jest.fn(),
    quit: jest.fn(),
  };
  const authorization = {
    requirePage: jest.fn().mockRejectedValue(new Error('revoked')),
  };
  const registry = new CollaborationConnectionRegistry(
    authorization as any,
    {
      findById: jest
        .fn()
        .mockResolvedValue({ id: page1, workspaceId, spaceId }),
    } as any,
    { findById: jest.fn().mockResolvedValue({ id: 'user-1' }) } as any,
    {
      getOrThrow: jest.fn().mockReturnValue({
        duplicate: jest.fn().mockReturnValue(subscriber),
      }),
    } as any,
  );
  return {
    registry,
    authorization,
    onMessage: (payload: string) => onMessage('', payload),
  };
}

async function connect(
  registry: CollaborationConnectionRegistry,
  pageId: string,
  connection = { readOnly: true, close: jest.fn() },
  context: Record<string, unknown> = {},
  instance: any = {
    shouldUnloadDocument: jest.fn().mockReturnValue(true),
    unloadDocument: jest.fn(),
  },
) {
  Object.defineProperty(connection, 'document', {
    value: { name: `page.${pageId}` },
  });
  await registry.connected({
    socketId: `socket-${pageId}`,
    documentName: `page.${pageId}`,
    context: {
      user: { id: 'user-1' },
      pageId,
      workspaceId,
      spaceId,
      ...context,
    },
    connection,
    instance,
  } as any);
  return { connection, instance };
}

describe('Idle collaboration revocation', () => {
  it('disconnects an idle reader on Core outage within 15 seconds including the Core deadline', async () => {
    jest.useFakeTimers();
    try {
      const { registry, authorization } = setup();
      authorization.requirePage.mockImplementation(
        () =>
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error('Core unavailable')), 3_000),
          ),
      );
      const { connection } = await connect(registry, page1);

      await jest.advanceTimersByTimeAsync(14_999);
      expect(connection.close).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);

      expect(authorization.requirePage).toHaveBeenCalledWith(
        expect.objectContaining({ id: page1 }),
        expect.objectContaining({ id: 'user-1' }),
        'VIEW',
      );
      expect(connection.close).toHaveBeenCalledWith({
        code: 4403,
        reason: 'authorization_revoked',
      });
      registry.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('evicts the in-memory Ydoc immediately after a pushed revocation', async () => {
    jest.useFakeTimers();
    try {
      const { registry, onMessage } = setup();
      const { connection, instance } = await connect(registry, page1);

      onMessage(
        JSON.stringify({
          event_id: '00000000-0000-4000-8000-000000000001',
          workspace_id: workspaceId,
          resource_kind: 'DOCMOST_PAGE',
          resource_id: page1,
          resource_version: 1,
        }),
      );

      expect(connection.close).toHaveBeenCalledWith({
        code: 4403,
        reason: 'authorization_revoked',
      });
      await jest.runOnlyPendingTimersAsync();
      expect(instance.unloadDocument).toHaveBeenCalledWith(
        expect.objectContaining({ name: `page.${page1}` }),
      );
      registry.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores duplicate and out-of-order resource versions', async () => {
    const { registry, onMessage } = setup();
    const { connection: newerConnection } = await connect(registry, page1);
    const revocation = (eventId: string, resourceVersion: number) =>
      JSON.stringify({
        event_id: eventId,
        workspace_id: workspaceId,
        resource_kind: 'DOCMOST_PAGE',
        resource_id: page1,
        resource_version: resourceVersion,
      });

    onMessage(revocation('00000000-0000-4000-8000-000000000003', 3));
    expect(newerConnection.close).toHaveBeenCalledTimes(1);

    const { connection: staleConnection } = await connect(registry, page1);
    onMessage(revocation('00000000-0000-4000-8000-000000000002', 2));
    onMessage(revocation('00000000-0000-4000-8000-000000000003', 3));
    expect(staleConnection.close).not.toHaveBeenCalled();
    registry.onModuleDestroy();
  });

  it('waits for the final disconnect before evicting a pushed-revocation document', async () => {
    jest.useFakeTimers();
    try {
      const { registry, onMessage } = setup();
      const instance = {
        shouldUnloadDocument: jest
          .fn()
          .mockReturnValueOnce(false)
          .mockReturnValue(true),
        unloadDocument: jest.fn(),
      };
      await connect(registry, page1, undefined, {}, instance);

      onMessage(
        JSON.stringify({
          event_id: '00000000-0000-4000-8000-000000000004',
          workspace_id: workspaceId,
          resource_kind: 'DOCMOST_PAGE',
          resource_id: page1,
          resource_version: 4,
        }),
      );
      await jest.runOnlyPendingTimersAsync();

      expect(instance.shouldUnloadDocument).toHaveBeenCalledTimes(2);
      expect(instance.unloadDocument).toHaveBeenCalledTimes(1);
      registry.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('disconnects every matching workspace/space/page scope', async () => {
    const { registry, onMessage } = setup();
    const { connection: inSpace } = await connect(registry, page1);
    const { connection: otherSpace } = await connect(
      registry,
      page2,
      undefined,
      { spaceId: '20000000-0000-4000-8000-000000000002' },
    );
    const { connection: otherWorkspace } = await connect(
      registry,
      page3,
      undefined,
      { workspaceId: '10000000-0000-4000-8000-000000000002' },
    );

    onMessage(
      JSON.stringify({
        event_id: '00000000-0000-4000-8000-000000000001',
        workspace_id: workspaceId,
        resource_kind: 'DOCMOST_SPACE',
        resource_id: spaceId,
        resource_version: 2,
      }),
    );
    expect(inSpace.close).toHaveBeenCalled();
    expect(otherSpace.close).not.toHaveBeenCalled();
    expect(otherWorkspace.close).not.toHaveBeenCalled();

    onMessage(
      JSON.stringify({
        event_id: '00000000-0000-4000-8000-000000000002',
        workspace_id: workspaceId,
        resource_kind: 'DOCMOST_PAGE',
        resource_id: page2,
        resource_version: 3,
      }),
    );
    expect(otherSpace.close).toHaveBeenCalled();

    registry.disconnectWorkspace('10000000-0000-4000-8000-000000000002');
    expect(otherWorkspace.close).toHaveBeenCalled();
    registry.onModuleDestroy();
  });
});
