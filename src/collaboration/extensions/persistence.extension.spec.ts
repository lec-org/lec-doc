import { Connection, Document, Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import { PersistenceExtension } from './persistence.extension';

function extension(authorization: any, users: any) {
  return new PersistenceExtension(
    { findById: jest.fn().mockResolvedValue({ id: 'page-1', workspaceId: 'workspace-1' }) } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    authorization,
    users,
  );
}

describe('Collaboration persistence authorization fence', () => {
  it('records actor capability synchronously and keeps newer epochs after committing a checkpoint', async () => {
    const service = extension({ requirePage: jest.fn() }, { findById: jest.fn() });
    const user = { id: 'user-1' };
    const changed = service.onChange({
      documentName: 'page.page-1',
      context: { user, writeCapability: 'EDIT' },
    } as any);
    expect((service as any).dirtyActors('page.page-1')).toEqual([
      { userId: 'user-1', capability: 'EDIT', epoch: 1 },
    ]);
    await changed;
    const checkpoint = (service as any).dirtyActors('page.page-1');
    await service.onChange({
      documentName: 'page.page-1',
      context: { user, writeCapability: 'EDIT' },
    } as any);
    (service as any).consumeActors('page.page-1', checkpoint);
    expect((service as any).dirtyActors('page.page-1')).toEqual([
      { userId: 'user-1', capability: 'EDIT', epoch: 2 },
    ]);
  });

  it('keeps the strongest capability when one actor edits then comments before a store', async () => {
    const authorization = { requirePage: jest.fn().mockResolvedValue(undefined) };
    const users = {
      findById: jest
        .fn()
        .mockResolvedValue({ id: 'user-1', workspaceId: 'workspace-1' }),
    };
    const page = {
      id: 'page-1',
      workspaceId: 'workspace-1',
      creatorId: 'user-1',
      contributorIds: [],
      content: null,
      spaceId: 'space-1',
      slugId: 'slug-1',
      createdAt: new Date(),
    };
    const service = new PersistenceExtension(
      { findById: jest.fn().mockResolvedValue(page), updatePage: jest.fn() } as any,
      { transaction: () => ({ execute: (callback: any) => callback({}) }) } as any,
      { add: jest.fn() } as any,
      { add: jest.fn() } as any,
      { addContributors: jest.fn() } as any,
      {
        syncPageTransclusions: jest.fn(),
        syncPageReferences: jest.fn(),
      } as any,
      authorization as any,
      users as any,
    );
    const document = new Y.Doc() as any;
    document.broadcastStateless = jest.fn();
    document
      .getXmlFragment('default')
      .insert(0, [new Y.XmlElement('paragraph')]);
    const context = { user: { id: 'user-1' } };
    await service.onChange({
      documentName: 'page.page-1',
      context: { ...context, writeCapability: 'EDIT' },
    } as any);
    await service.onChange({
      documentName: 'page.page-1',
      context: { ...context, writeCapability: 'COMMENT' },
    } as any);

    await service.onStoreDocument({
      documentName: 'page.page-1',
      document,
      lastContext: {},
    } as any);

    expect(authorization.requirePage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'page-1' }),
      expect.objectContaining({ id: 'user-1' }),
      'EDIT',
    );
  });

  it('persists only the authorized snapshot and leaves a racing actor for the next store', async () => {
    let release: () => void;
    const authorization = {
      requirePage: jest
        .fn()
        .mockImplementationOnce(
          () => new Promise<void>((resolve) => (release = resolve)),
        )
        .mockResolvedValue(undefined),
    };
    const users = {
      findById: jest.fn().mockImplementation((id) =>
        Promise.resolve({ id, workspaceId: 'workspace-1' }),
      ),
    };
    const page = {
      id: 'page-1',
      workspaceId: 'workspace-1',
      creatorId: 'user-1',
      contributorIds: [],
      content: null,
      spaceId: 'space-1',
      slugId: 'slug-1',
      createdAt: new Date(),
    };
    const updatePage = jest.fn();
    const db = {
      transaction: () => ({ execute: (callback: any) => callback({}) }),
    };
    const service = new PersistenceExtension(
      { findById: jest.fn().mockResolvedValue(page), updatePage } as any,
      db as any,
      { add: jest.fn() } as any,
      { add: jest.fn() } as any,
      { addContributors: jest.fn() } as any,
      {
        syncPageTransclusions: jest.fn(),
        syncPageReferences: jest.fn(),
      } as any,
      authorization as any,
      users as any,
    );
    const document = new Y.Doc() as any;
    document.broadcastStateless = jest.fn();
    document
      .getXmlFragment('default')
      .insert(0, [new Y.XmlElement('paragraph')]);
    await service.onChange({
      documentName: 'page.page-1',
      context: { user: { id: 'user-1' }, writeCapability: 'EDIT' },
    } as any);

    const firstStore = service.onStoreDocument({
      documentName: 'page.page-1',
      document,
      lastContext: {},
    } as any);
    while (!release) await new Promise((resolve) => setImmediate(resolve));

    document
      .getXmlFragment('default')
      .insert(1, [new Y.XmlElement('paragraph')]);
    await service.onChange({
      documentName: 'page.page-1',
      context: { user: { id: 'user-2' }, writeCapability: 'COMMENT' },
    } as any);
    release();
    await firstStore;

    const firstSnapshot = new Y.Doc();
    Y.applyUpdate(firstSnapshot, updatePage.mock.calls[0][0].ydoc);
    expect(firstSnapshot.getXmlFragment('default').length).toBe(1);
    expect((service as any).dirtyActors('page.page-1')).toEqual([
      { userId: 'user-2', capability: 'COMMENT', epoch: 2 },
    ]);

    await service.onStoreDocument({
      documentName: 'page.page-1',
      document,
      lastContext: {},
    } as any);
    const secondSnapshot = new Y.Doc();
    Y.applyUpdate(secondSnapshot, updatePage.mock.calls[1][0].ydoc);
    expect(secondSnapshot.getXmlFragment('default').length).toBe(2);
    expect(
      authorization.requirePage.mock.calls.map((call: any[]) => [
        call[1].id,
        call[2],
      ]),
    ).toEqual([
      ['user-1', 'EDIT'],
      ['user-2', 'COMMENT'],
    ]);
    expect((service as any).dirtyActors('page.page-1')).toEqual([]);
  });

  it('closes, evicts after the failed store releases its mutex, and reloads canonical state', async () => {
    jest.useFakeTimers();
    try {
      const authorization = {
        requirePage: jest
          .fn()
          .mockRejectedValueOnce(new Error('revoked'))
          .mockResolvedValue(undefined),
      };
      const users = {
        findById: jest
          .fn()
          .mockResolvedValue({ id: 'user-1', workspaceId: 'workspace-1' }),
      };
      const canonical = new Y.Doc();
      canonical
        .getXmlFragment('default')
        .insert(0, [new Y.XmlElement('canonical')]);
      const pages = {
        findById: jest.fn().mockImplementation((_id, options) =>
          Promise.resolve(
            options?.includeYdoc
              ? { id: 'page-1', ydoc: Buffer.from(Y.encodeStateAsUpdate(canonical)) }
              : { id: 'page-1', workspaceId: 'workspace-1' },
          ),
        ),
      };
      const service = new PersistenceExtension(
        pages as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        authorization as any,
        users as any,
      );
      await service.onChange({
        documentName: 'page.page-1',
        context: { user: { id: 'user-1' }, writeCapability: 'COMMENT' },
      } as any);
      const instance = new Hocuspocus({ extensions: [service] });
      const close = jest.spyOn(Connection.prototype, 'close');
      const direct = await instance.openDirectConnection('page.page-1', {
        user: { id: 'user-1' },
        pageId: 'page-1',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        writeCapability: 'COMMENT',
      });
      await direct.transact((document) =>
        document
          .getXmlFragment('default')
          .insert(0, [new Y.XmlElement('unauthorized')]),
      );
      const socket = {
        readyState: 1,
        send: jest.fn(),
        close: jest.fn(),
      };
      new Connection(
        socket,
        new Request('http://localhost'),
        (direct as unknown as { document: Document }).document,
        'socket-1',
        {
          user: { id: 'user-2' },
          pageId: 'page-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          writeCapability: 'EDIT',
        },
      );

      await expect(direct.disconnect()).resolves.toBeUndefined();
      expect(authorization.requirePage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'page-1' }),
        expect.objectContaining({ id: 'user-1' }),
        'COMMENT',
      );
      expect(close).toHaveBeenCalledWith({
        code: 4205,
        reason: 'Reset Connection',
      });
      await jest.runAllTimersAsync();
      expect(instance.getDocumentsCount()).toBe(0);
      const reloaded = await instance.openDirectConnection('page.page-1');
      expect(
        (
          (reloaded as unknown as { document: Document }).document
            .getXmlFragment('default')
            .get(0) as Y.XmlElement
        ).nodeName,
      ).toBe('canonical');
      expect((service as any).dirtyActors('page.page-1')).toEqual([]);
      await reloaded.disconnect();
    } finally {
      jest.useRealTimers();
    }
  });
});
