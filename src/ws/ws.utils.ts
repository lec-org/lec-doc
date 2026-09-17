export function getSpaceRoomName(spaceId: string): string {
  return `space-${spaceId}`;
}

export function getUserRoomName(userId: string): string {
  return `user-${userId}`;
}

export const TREE_EVENTS = new Set([
  'updateOne',
  'addTreeNode',
  'moveTreeNode',
  'deleteTreeNode',
  'refetchRootTreeNodeEvent',
]);

