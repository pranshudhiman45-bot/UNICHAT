import type { Message } from '../types';
import { idOf } from '../types';

export function messageLink(message: Message, workspaceId: string, origin: string): string | null {
  const channelId = idOf(message.channel);
  const dmId = idOf(message.dm);
  if (!workspaceId || (!channelId && !dmId)) return null;
  const url = new URL(`/chat/${encodeURIComponent(workspaceId)}`, origin);
  if (channelId) url.searchParams.set('channelId', channelId);
  else if (dmId) url.searchParams.set('dmId', dmId);
  const parentId = idOf(message.thread?.parentMessage);
  if (parentId) url.searchParams.set('threadParentId', parentId);
  url.searchParams.set('messageId', message._id);
  return url.href;
}
