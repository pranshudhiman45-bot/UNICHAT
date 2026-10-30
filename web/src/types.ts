export interface User {
  _id: string;
  role?: 'SUPER_ADMIN' | 'USER';
  accountStatus?: 'active' | 'disabled';
  username: string;
  displayName: string;
  avatar?: string | null;
  status?: 'online' | 'away' | 'busy' | 'offline';
  statusMessage?: string;
  title?: string;
  bio?: string;
  timezone?: string;
  lastSeen?: string;
}

export interface WorkspaceMember {
  user: User;
  role: 'owner' | 'admin' | 'member' | 'guest';
}

export interface Workspace {
  pendingJoinRequestCount?: number;
  _id: string;
  name: string;
  slug: string;
  description?: string;
  icon?: string | null;
  inviteCode?: string;
  members?: WorkspaceMember[];
}

export interface Channel {
  _id: string;
  workspace: string;
  name: string;
  type: 'public' | 'private';
  description: string;
  isMember?: boolean;
  unreadCount?: number;
  mentionCount?: number;
  canPin?: boolean;
  isMuted?: boolean;
  members?: Array<{ user: string | User; role?: string }>;
}

export interface DirectMessage {
  _id: string;
  workspace: string;
  participants: User[];
  isGroup: boolean;
  groupName?: string;
  lastMessage?: {
    _id: string;
    content: string;
    sender?: User;
    createdAt: string;
  } | null;
  lastActivity: string;
  unreadCount?: number;
  mentionCount?: number;
  isMuted?: boolean;
}

export interface Reaction {
  emoji: string;
  users: string[];
  count: number;
}

export interface Attachment {
  uploadId?: string;
  type: 'image' | 'document' | 'video' | 'audio' | 'link';
  url: string;
  urlExpiresAt?: number;
  urlRequired?: boolean;
  secureUrl?: string;
  publicId?: string;
  name?: string;
  size?: number;
  mimeType?: string;
  width?: number;
  height?: number;
  thumbnail?: string;
  duration?: number;
  format?: string;
  resourceType?: string;
  accessMode?: 'public' | 'authenticated';
}

export interface Message {
  isDeleted?: boolean;
  _id: string;
  content: string;
  formattedContent?: string;
  channel?: string | { _id: string };
  dm?: string | { _id: string };
  sender: User;
  createdAt: string;
  isEdited?: boolean;
  isSystemMessage?: boolean;
  reactions?: Reaction[];
  mentions?: string[];
  attachments?: Attachment[];
  isPinned?: boolean;
  forwardedFrom?: {
    senderName: string;
    conversationName: string;
    createdAt: string;
    isThreadReply?: boolean;
  };
  thread?: {
    parentMessage?: string | { _id: string } | null;
    replyCount?: number;
    lastReplyAt?: string;
    participants?: User[];
  };
}

export interface SearchResult extends Message {
  threadParentId?: string | null;
  isThreadReply?: boolean;
  conversation?: { type: 'channel' | 'dm'; id: string; name: string } | null;
  channel?: (string | { _id: string; name?: string; type?: Channel['type'] });
  dm?: (string | { _id: string; isGroup?: boolean; groupName?: string; participants?: User[] });
}

export interface SavedMessage {
  _id: string;
  message: Message;
  channel?: Channel | null;
  dm?: DirectMessage | null;
  createdAt: string;
}

export interface PinnedMessage {
  message: Message;
  pinnedBy?: User;
  pinnedAt: string;
}

export type NotificationType = 'mention' | 'thread_reply' | 'reaction' | 'direct_message' | 'channel_message' | 'channel_invite' | 'workspace_invite' | 'workspace_join_request' | 'workspace_join_approved' | 'file_shared' | 'call_invite' | 'missed_call' | 'password_recovery' | 'security_alert' | 'admin_alert' | 'system';

export interface NotificationItem {
  _id: string;
  workspace: string | Workspace;
  recipient: string;
  actor?: User;
  type: NotificationType;
  message?: Message | null;
  channel?: { _id: string; name: string; type?: Channel['type'] } | null;
  dm?: { _id: string; isGroup?: boolean; groupName?: string; participants?: User[] } | null;
  threadParent?: string | { _id: string } | null;
  content?: string;
  metadata?: { emoji?: string; preview?: string; event?: string; channelName?: string; requestId?: string; attachmentCount?: number; batchedCount?: number; deliverySuppressed?: boolean; sound?: boolean };
  readAt?: string | null;
  isRead?: boolean;
  createdAt: string;
}

export interface NotificationPreference {
  workspace: string;
  level: 'all' | 'mentions_dms' | 'mentions' | 'important' | 'nothing' | 'muted';
  notifyThreadReplies?: boolean;
  notifyReactions?: boolean;
  playSound?: boolean;
  mutedChannels?: string[];
  mutedDMs?: string[];
  dndUntil?: string | null;
}

export function idOf(value?: string | { _id: string } | null) {
  return typeof value === 'string' ? value : value?._id;
}
