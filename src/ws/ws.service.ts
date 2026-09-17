import { Injectable } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { SpaceRole } from '../common/helpers/types/permission';
import { LecAuthorizationService } from '../core/lec-authorization/lec-authorization.service';
import {
  TREE_EVENTS,
  getSpaceRoomName,
  getUserRoomName,
} from './ws.utils';

@Injectable()
export class WsService {
  private server: Server;

  constructor(
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly authorization: LecAuthorizationService,
  ) {}

  setServer(server: Server): void {
    this.server = server;
  }

  async handleTreeEvent(client: Socket, data: any): Promise<void> {
    const room = getSpaceRoomName(data.spaceId);

    if (!client.rooms.has(room) || !client.data.user) return;
    try {
      await this.authorization.requireSpace(
        data.spaceId,
        client.data.workspaceId,
        client.data.user,
        'EDIT',
      );
    } catch {
      client.leave(room);
      return;
    }

    const userSpaceRoles = await this.spaceMemberRepo.getUserSpaceRoles(
      client.data.userId,
      data.spaceId,
    );
    const canPublish = userSpaceRoles?.some(
      ({ role }) => role === SpaceRole.ADMIN || role === SpaceRole.WRITER,
    );

    if (!canPublish) {
      return;
    }

    if (data.operation === 'refetchRootTreeNodeEvent') {
      await this.broadcastToAuthorizedSpaceUsers(
        room,
        client.id,
        data.spaceId,
        data,
      );
      return;
    }

    const pageId = this.extractPageId(data);
    if (!pageId) {
      return;
    }

    await this.broadcastToAuthorizedUsers(room, client.id, pageId, data);
  }

  async emitCommentEvent(
    spaceId: string,
    pageId: string,
    data: any,
  ): Promise<void> {
    const room = getSpaceRoomName(spaceId);

    await this.broadcastToAuthorizedUsers(room, null, pageId, data);
  }

  async emitToUsers(
    userIds: string[],
    pageId: string,
    data: any,
  ): Promise<void> {
    if (userIds.length === 0) return;
    const sockets = await this.server
      .in(userIds.map((id) => getUserRoomName(id)))
      .fetchSockets();
    for (const socket of sockets) {
      try {
        await this.authorization.requirePage(
          {
            id: pageId,
            workspaceId: socket.data.workspaceId,
            deletedAt: null,
          },
          socket.data.user,
          'VIEW',
        );
        socket.emit('message', data);
      } catch {
        // Core is the only allow source; do not emit on deny or outage.
      }
    }
  }

  async emitToSpaceExceptUsers(
    spaceId: string,
    excludeUserIds: string[],
    pageId: string,
    data: any,
  ): Promise<void> {
    const room = getSpaceRoomName(spaceId);
    const sockets = await this.server.in(room).fetchSockets();
    const excludeSet = new Set(excludeUserIds);

    for (const socket of sockets) {
      const userId = socket.data.userId as string;
      if (!userId || excludeSet.has(userId)) continue;
      try {
        await this.authorization.requirePage(
          {
            id: pageId,
            workspaceId: socket.data.workspaceId,
            deletedAt: null,
          },
          socket.data.user,
          'VIEW',
        );
        socket.emit('message', data);
      } catch {
        socket.leave(room);
      }
    }
  }

  isTreeEvent(data: any): boolean {
    return TREE_EVENTS.has(data?.operation) && !!data?.spaceId;
  }

  private async broadcastToAuthorizedSpaceUsers(
    room: string,
    excludeSocketId: string | null,
    spaceId: string,
    data: any,
  ) {
    const sockets = await this.server.in(room).fetchSockets();
    for (const socket of sockets) {
      if (socket.id === excludeSocketId || !socket.data.user) continue;
      try {
        await this.authorization.requireSpace(
          spaceId,
          socket.data.workspaceId,
          socket.data.user,
          'VIEW',
        );
        socket.emit('message', data);
      } catch {
        socket.leave(room);
      }
    }
  }

  private async broadcastToAuthorizedUsers(
    room: string,
    excludeSocketId: string | null,
    pageId: string,
    data: any,
  ): Promise<void> {
    const sockets = await this.server.in(room).fetchSockets();

    // Exclude only the originating socket, not every socket of the originating
    // user. Excluding by userId silently dropped the originator's other tabs
    // from receiving restricted-space tree events.
    const otherSockets = excludeSocketId
      ? sockets.filter((s) => s.id !== excludeSocketId)
      : sockets;
    if (otherSockets.length === 0) return;

    const userSocketMap = new Map<string, typeof otherSockets>();
    for (const socket of otherSockets) {
      const userId = socket.data.userId as string;
      if (!userId) continue;
      const existing = userSocketMap.get(userId);
      if (existing) {
        existing.push(socket);
      } else {
        userSocketMap.set(userId, [socket]);
      }
    }

    const candidateUserIds = Array.from(userSocketMap.keys());
    if (candidateUserIds.length === 0) return;

    const authorizedUserIds =
      await this.pagePermissionRepo.getUserIdsWithPageAccess(
        pageId,
        candidateUserIds,
      );

    const authorizedSet = new Set(authorizedUserIds);
    for (const [userId, userSockets] of userSocketMap) {
      if (!authorizedSet.has(userId)) continue;
      for (const socket of userSockets) {
        try {
          const page = {
            id: pageId,
            workspaceId: socket.data.workspaceId,
            deletedAt: null,
          };
          await this.authorization.requirePage(
            page,
            socket.data.user,
            'VIEW',
          );
          socket.emit('message', data);
        } catch {
          socket.leave(room);
        }
      }
    }
  }

  private extractPageId(data: any): string | null {
    switch (data.operation) {
      case 'addTreeNode':
        return data.payload?.data?.id ?? null;
      case 'moveTreeNode':
        return data.payload?.id ?? null;
      case 'deleteTreeNode':
        return data.payload?.node?.id ?? null;
      case 'updateOne':
        return data.id ?? null;
      default:
        return null;
    }
  }
}
