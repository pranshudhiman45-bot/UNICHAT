import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Socket } from 'socket.io-client';
import AppShell from '../components/layout/AppShell';
import ConversationHeader, { type ConversationView } from '../components/conversations/ConversationHeader';
import NewMessageModal from '../components/conversations/NewMessageModal';
import CreateChannelModal from '../components/channels/CreateChannelModal';
import EmptyState from '../components/common/EmptyState';
import MessageComposer from '../components/messages/MessageComposer';
import MessageList from '../components/messages/MessageList';
import ForwardMessageModal, { type ForwardTarget } from '../components/messages/ForwardMessageModal';
import ThreadPanel from '../components/threads/ThreadPanel';
import ChannelDetailsModal from '../components/channels/ChannelDetailsModal';
import GroupDetailsModal from '../components/conversations/GroupDetailsModal';
import WorkspaceMembersModal from '../components/workspaces/WorkspaceMembersModal';
import { api, getAccessToken, useAuth } from '../hooks/useAuth';
import { connectSocket, disconnectSocket } from '../services/socket';
import { primeNotificationSound, refreshBrowserPush, showLiveBrowserAlert } from '../services/browserNotifications';
import type { Attachment, Channel, DirectMessage, Message, NotificationItem, PinnedMessage, Reaction, SavedMessage, SearchResult, User, Workspace } from '../types';
import { idOf } from '../types';
import { dmTitle } from '../components/layout/WorkspaceSidebar';

type ActiveType = 'channel' | 'dm';
const MAX_LOADED_MESSAGES = 1500;

// Idempotent send: the same clientMessageId is reused on every retry, so a lost response can never create a duplicate.
async function postMessage(payload: Record<string, unknown>) {
  const clientMessageId = crypto.randomUUID();
  let lastError: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await api.post('/messages', { ...payload, clientMessageId }); }
    catch (err: any) {
      lastError = err;
      const status = err.response?.status;
      if (status && status < 500) throw err; // validation/authorization errors are final
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError;
}

function sameContext(message: Message, type: ActiveType, id: string | undefined) {
  return type === 'channel' ? idOf(message.channel) === id : idOf(message.dm) === id;
}

function makeTypingText(ids: string[], members: User[]) {
  const names = ids.map((id) => members.find((member) => member._id === id)?.displayName).filter(Boolean) as string[];
  if (!names.length) return '';
  if (names.length === 1) return names[0] + ' is typing…';
  if (names.length === 2) return names[0] + ' and ' + names[1] + ' are typing…';
  return names[0] + ', ' + names[1] + ' and ' + (names.length - 2) + ' others are typing…';
}

function hasMention(message: Message, userId: string) {
  return message.mentions?.some((id) => String(id) === userId) || false;
}

function mergeReaction(messages: Message[], messageId: string, reactions: Reaction[]) {
  return messages.map((message) => message._id === messageId ? { ...message, reactions } : message);
}

export default function Chat() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [members, setMembers] = useState<User[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [dms, setDms] = useState<DirectMessage[]>([]);
  const [activeType, setActiveType] = useState<ActiveType>('channel');
  const [activeId, setActiveId] = useState<string>();
  const [conversationView, setConversationView] = useState<ConversationView>('messages');
  const [messages, setMessages] = useState<Message[]>([]);
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const [unreadChannels, setUnreadChannels] = useState<Record<string, number>>({});
  const [unreadDMs, setUnreadDMs] = useState<Record<string, number>>({});
  const [mentionChannels, setMentionChannels] = useState<Record<string, number>>({});
  const [mentionDMs, setMentionDMs] = useState<Record<string, number>>({});
  const [typingUsers, setTypingUsers] = useState<Record<string, string[]>>({});
  const [threadParent, setThreadParent] = useState<Message | null>(null);
  const [threadReplies, setThreadReplies] = useState<Message[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState('');
  const [threadUnread, setThreadUnread] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [error, setError] = useState('');
  const [messageError, setMessageError] = useState('');
  const [socketConnected, setSocketConnected] = useState(false);
  const [showNewMessage, setShowNewMessage] = useState(false);
  const [forwardingMessage, setForwardingMessage] = useState<Message | null>(null);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [joiningChannel, setJoiningChannel] = useState(false);
  const [activityUnreadCount, setActivityUnreadCount] = useState(0);
  const [savedMessageIds, setSavedMessageIds] = useState<Set<string>>(new Set());
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderCursorRef = useRef<{ before: string; beforeId: string } | null>(null);
  const loadingOlderRef = useRef(false);
  const loadedCountRef = useRef(0);
  const lastSyncRef = useRef<string | null>(null);
  const hasConnectedRef = useRef(false);
  const typingTimersRef = useRef(new Map<string, number>());
  const markReadTimer = useRef<number | undefined>(undefined);
  const conversationRequest = useRef(0);
  const workspaceIdRef = useRef(workspaceId); workspaceIdRef.current = workspaceId;
  const socketRef = useRef<Socket | null>(null);
  const activeRef = useRef({ type: 'channel' as ActiveType, id: undefined as string | undefined });
  const threadRef = useRef<Message | null>(null);
  const notificationSettingsRef = useRef(user?.notificationSettings);
  useEffect(() => { notificationSettingsRef.current = user?.notificationSettings; }, [user?.notificationSettings]);
  useEffect(() => { if (user?.notificationSettings?.webPushEnabled) void refreshBrowserPush().catch(() => undefined); }, [user?._id, user?.notificationSettings?.webPushEnabled]);
  useEffect(() => {
    if (!user?.notificationSettings?.webPushEnabled || user.notificationSettings.sounds === false) return;
    document.addEventListener('pointerdown', primeNotificationSound, { once: true });
    document.addEventListener('keydown', primeNotificationSound, { once: true });
    return () => {
      document.removeEventListener('pointerdown', primeNotificationSound);
      document.removeEventListener('keydown', primeNotificationSound);
    };
  }, [user?.notificationSettings?.webPushEnabled, user?.notificationSettings?.sounds]);

  useEffect(() => { loadedCountRef.current = messages.length; }, [messages.length]);
  const activeChannel = useMemo(() => channels.find((channel) => channel._id === activeId) || null, [channels, activeId]);
  const activeDM = useMemo(() => dms.find((dm) => dm._id === activeId) || null, [dms, activeId]);
  const typingKey = activeId ? activeType + ':' + activeId : '';
  const typingText = makeTypingText(typingKey ? typingUsers[typingKey] || [] : [], members);
  const threadTypingText = threadParent ? makeTypingText(typingUsers['thread:' + threadParent._id] || [], members) : '';
  const activeContextMemberIds = activeType === 'channel'
    ? (activeChannel?.members || []).map((member) => idOf(member.user)).filter(Boolean) as string[]
    : (activeDM?.participants || []).map((member) => member._id);
  const workspaceHasUnread = Object.values(unreadChannels).some((count) => count > 0) || Object.values(unreadDMs).some((count) => count > 0);

  useEffect(() => { activeRef.current = { type: activeType, id: activeId }; }, [activeType, activeId]);

  const applyFirstPage = (data: { messages: Message[]; hasMore?: boolean; nextCursor?: { before: string; beforeId: string } | null; lastReadAt?: string | null; serverTime?: string }) => {
    setMessages(data.messages);
    setLastReadAt(data.lastReadAt || null);
    olderCursorRef.current = data.nextCursor || null;
    setHasMoreOlder(Boolean(data.nextCursor));
    lastSyncRef.current = data.serverTime || null;
  };

  const loadOlder = useCallback(async () => {
    const cursor = olderCursorRef.current; const { type, id } = activeRef.current; const request = conversationRequest.current;
    if (!cursor || !id || loadingOlderRef.current) return;
    loadingOlderRef.current = true; setLoadingOlder(true);
    try {
      const response = await api.get(type === 'channel' ? '/messages/channel/' + id : '/dms/' + id + '/messages', { params: { limit: 50, before: cursor.before, beforeId: cursor.beforeId } });
      if (request !== conversationRequest.current) return;
      setMessages((current) => {
        const have = new Set(current.map((message) => message._id));
        const merged = [...(response.data.messages as Message[]).filter((message) => !have.has(message._id)), ...current];
        return merged;
      });
      // Bound memory: stop loading at MAX_LOADED_MESSAGES; search covers anything older.
      const reachedCap = loadedCountRef.current + response.data.messages.length >= MAX_LOADED_MESSAGES;
      const next = reachedCap ? null : ((response.data.nextCursor as { before: string; beforeId: string } | null) || null);
      olderCursorRef.current = next; setHasMoreOlder(Boolean(next));
    } catch (err: any) { if (request === conversationRequest.current) setMessageError(err.response?.data?.error || 'Unable to load earlier messages'); }
    finally { loadingOlderRef.current = false; setLoadingOlder(false); }
  }, []);

  const closeThread = useCallback(() => {
    const current = threadRef.current;
    if (current) socketRef.current?.emit('thread:leave', current._id);
    threadRef.current = null;
    setThreadParent(null);
    setThreadReplies([]);
    setThreadError('');
  }, []);

  const setInitialUnread = (nextChannels: Channel[], nextDms: DirectMessage[]) => {
    setUnreadChannels(Object.fromEntries(nextChannels.filter((channel) => (channel.unreadCount || 0) > 0).map((channel) => [channel._id, channel.unreadCount || 0])));
    setUnreadDMs(Object.fromEntries(nextDms.filter((dm) => (dm.unreadCount || 0) > 0).map((dm) => [dm._id, dm.unreadCount || 0])));
    setMentionChannels(Object.fromEntries(nextChannels.filter((channel) => (channel.mentionCount || 0) > 0).map((channel) => [channel._id, channel.mentionCount || 0])));
    setMentionDMs(Object.fromEntries(nextDms.filter((dm) => (dm.mentionCount || 0) > 0).map((dm) => [dm._id, dm.mentionCount || 0])));
  };

  const loadSavedMessages = useCallback(async () => {
    if (!workspaceId) return;
    const response = await api.get('/saved?workspaceId=' + workspaceId);
    if (workspaceIdRef.current !== workspaceId) return;
    const nextItems = response.data.saved as SavedMessage[];
    setSavedMessageIds(new Set(nextItems.map((item) => item.message?._id).filter(Boolean)));
    window.dispatchEvent(new CustomEvent('unichat:saved-state', { detail: { ids: nextItems.map((item) => item.message?._id).filter(Boolean) } }));
  }, [workspaceId]);

  const loadActivityCount = useCallback(async () => {
    if (!workspaceId) return;
    const response = await api.get('/notifications/unread-count?scope=activity&workspaceId=' + workspaceId);
    if (workspaceIdRef.current === workspaceId) setActivityUnreadCount(response.data.unreadCount || 0);
  }, [workspaceId]);

  useEffect(() => { if (workspaceId && user) void loadSavedMessages().catch(() => undefined); }, [workspaceId, user?._id, loadSavedMessages]);
  useEffect(() => { if (workspaceId && user) void loadActivityCount().catch(() => undefined); }, [workspaceId, user?._id, loadActivityCount]);
  useEffect(() => { window.dispatchEvent(new CustomEvent('unichat:activity-count', { detail: { count: activityUnreadCount } })); }, [activityUnreadCount]);

  const openChannel = useCallback(async (channel: Channel) => {
    const request = ++conversationRequest.current;
    closeThread();
    if (activeRef.current.id && activeRef.current.id !== channel._id) socketRef.current?.emit(activeRef.current.type === 'channel' ? 'channel:leave' : 'dm:leave', activeRef.current.id);
    activeRef.current = { type: 'channel', id: channel._id };
    setActiveType('channel'); setActiveId(channel._id); setConversationView('messages'); setMessages([]); setMessageError(''); setLastReadAt(null); olderCursorRef.current = null; setHasMoreOlder(false); lastSyncRef.current = null;
    socketRef.current?.emit('channel:join', channel._id);
    setLoadingConversation(true);
    try {
      const response = await api.get('/messages/channel/' + channel._id);
      if (request !== conversationRequest.current) return;
      applyFirstPage(response.data);
      await api.put('/channels/' + channel._id + '/mark-read');
      setUnreadChannels((current) => { const next = { ...current }; delete next[channel._id]; return next; });
      setMentionChannels((current) => { const next = { ...current }; delete next[channel._id]; return next; });
      setChannels((current) => current.map((item) => item._id === channel._id ? { ...item, unreadCount: 0, mentionCount: 0 } : item));
    } catch (err: any) { if (request === conversationRequest.current) setMessageError(err.response?.data?.error || 'Failed to load conversation'); }
    finally { if (request === conversationRequest.current) setLoadingConversation(false); }
  }, [closeThread]);

  const openDM = useCallback(async (dm: DirectMessage) => {
    const request = ++conversationRequest.current;
    closeThread();
    if (activeRef.current.id && activeRef.current.id !== dm._id) socketRef.current?.emit(activeRef.current.type === 'channel' ? 'channel:leave' : 'dm:leave', activeRef.current.id);
    activeRef.current = { type: 'dm', id: dm._id };
    setActiveType('dm'); setActiveId(dm._id); setConversationView('messages'); setMessages([]); setMessageError(''); setLastReadAt(null); olderCursorRef.current = null; setHasMoreOlder(false); lastSyncRef.current = null;
    socketRef.current?.emit('dm:join', dm._id);
    setLoadingConversation(true);
    try {
      const response = await api.get('/dms/' + dm._id + '/messages');
      if (request !== conversationRequest.current) return;
      applyFirstPage(response.data);
      await api.put('/dms/' + dm._id + '/mark-read');
      setUnreadDMs((current) => { const next = { ...current }; delete next[dm._id]; return next; });
      setMentionDMs((current) => { const next = { ...current }; delete next[dm._id]; return next; });
      setDms((current) => current.map((item) => item._id === dm._id ? { ...item, unreadCount: 0, mentionCount: 0 } : item));
    } catch (err: any) { if (request === conversationRequest.current) setMessageError(err.response?.data?.error || 'Failed to load conversation'); }
    finally { if (request === conversationRequest.current) setLoadingConversation(false); }
  }, [closeThread]);

  const openThread = useCallback(async (message: Message) => {
    closeThread();
    threadRef.current = message;
    setThreadParent(message); setThreadReplies([]); setThreadError(''); setThreadLoading(true);
    socketRef.current?.emit('thread:join', message._id);
    setThreadUnread((current) => ({ ...current, [message._id]: false }));
    try {
      const response = await api.get('/messages/' + message._id + '/thread');
      if (threadRef.current?._id !== message._id) return;
      setThreadParent(response.data.parent);
      setThreadReplies(response.data.replies || []);
    } catch (err: any) { setThreadError(err.response?.data?.error || 'Unable to load thread'); }
    finally { setThreadLoading(false); }
  }, [closeThread]);

  useEffect(() => {
    if (!workspaceId || !user) return;
    let cancelled = false;
    conversationRequest.current++; activeRef.current = { type: 'channel', id: undefined };
    setChannels([]); setDms([]); setMembers([]); setTypingUsers({}); setActivityUnreadCount(0); setSavedMessageIds(new Set());
    setLoading(true); setError(''); setWorkspace(null); setActiveId(undefined); setMessages([]); closeThread();
    Promise.all([api.get('/workspaces'), api.get('/workspaces/' + workspaceId), api.get('/channels/workspace/' + workspaceId), api.get('/dms?workspaceId=' + workspaceId)])
      .then(([workspaceList, workspaceResponse, channelResponse, dmResponse]) => {
        if (cancelled) return;
        const nextWorkspace = workspaceResponse.data.workspace as Workspace;
        const nextChannels = channelResponse.data.channels as Channel[];
        const nextDms = dmResponse.data.dms as DirectMessage[];
        setWorkspaces(workspaceList.data.workspaces); setWorkspace(nextWorkspace); setMembers((nextWorkspace.members || []).map((member) => member.user)); setChannels(nextChannels); setDms(nextDms); setInitialUnread(nextChannels, nextDms);
        const target = new URLSearchParams(window.location.search);
        const targetChannel = nextChannels.find((channel) => channel._id === target.get('channelId'));
        const targetDM = nextDms.find((dm) => dm._id === target.get('dmId'));
        if ((target.has('channelId') || target.has('dmId')) && !targetChannel && !targetDM) {
          setMessageError('This linked conversation is unavailable or you do not have access.');
          return;
        }
        if (targetChannel || targetDM) {
          void (async () => {
            if (targetChannel) await openChannel(targetChannel);
            else if (targetDM) await openDM(targetDM);
            if (cancelled) return;
            const parentId = target.get('threadParentId');
            const messageId = target.get('messageId');
            try {
              if (parentId) {
                const thread = await api.get('/messages/' + parentId + '/thread');
                const parent = thread.data.parent as Message;
                if (idOf(parent.channel) !== targetChannel?._id || idOf(parent.dm) !== targetDM?._id) throw new Error('Message does not belong to this conversation');
                await openThread(parent);
                if (cancelled) return;
              } else if (messageId) {
                const thread = await api.get('/messages/' + messageId + '/thread');
                if (cancelled) return;
                const linked = thread.data.parent as Message;
                if (linked._id !== messageId || idOf(linked.channel) !== targetChannel?._id || idOf(linked.dm) !== targetDM?._id) throw new Error('Message does not belong to this conversation');
                setMessages((current) => current.some((message) => message._id === linked._id) ? current : [...current, linked].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()));
              }
              if (messageId) window.setTimeout(() => { if (!cancelled) window.dispatchEvent(new CustomEvent('unichat:focus-message', { detail: { messageId } })); }, 150);
            } catch (cause: any) {
              if (!cancelled) setMessageError(cause.response?.data?.error || cause.message || 'Unable to open this message link');
            }
          })();
        } else if (!activeId || (!nextChannels.some((channel) => channel._id === activeId) && !nextDms.some((dm) => dm._id === activeId))) {
          if (nextChannels.length) void openChannel(nextChannels.find((channel) => channel.name === 'general') || nextChannels[0]); else if (nextDms.length) void openDM(nextDms[0]); else { setActiveType('channel'); setActiveId(undefined); }
        }
      }).catch((err: any) => { if (!cancelled) setError(err.response?.data?.error || 'Unable to load this workspace'); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; conversationRequest.current++; };
  }, [workspaceId, user?._id, openChannel, openDM, openThread, closeThread]);

  useEffect(() => {
    if (!workspaceId || !user) return;
    hasConnectedRef.current = false;
    const socket = connectSocket(getAccessToken()); socketRef.current = socket;
    const resync = async () => {
      // The database is the source of truth: after any gap, refetch what changed instead of trusting delivery.
      const { type, id } = activeRef.current; const since = lastSyncRef.current; const request = conversationRequest.current;
      try {
        const [channelResponse, dmResponse] = await Promise.all([api.get('/channels/workspace/' + workspaceId), api.get('/dms?workspaceId=' + workspaceId)]);
        if (workspaceIdRef.current !== workspaceId) return;
        const nextChannels = channelResponse.data.channels as Channel[]; const nextDms = dmResponse.data.dms as DirectMessage[];
        setChannels(nextChannels); setDms(nextDms);
        setInitialUnread(nextChannels.map((c) => c._id === id ? { ...c, unreadCount: 0, mentionCount: 0 } : c), nextDms.map((d) => d._id === id ? { ...d, unreadCount: 0, mentionCount: 0 } : d));
        void loadActivityCount().catch(() => undefined);
        if (!id || !since) return;
        const response = await api.get(type === 'channel' ? '/messages/channel/' + id + '/sync' : '/dms/' + id + '/sync', { params: { since: new Date(new Date(since).getTime() - 2000).toISOString() } });
        if (request !== conversationRequest.current) return;
        if (response.data.truncated) {
          const target = type === 'channel' ? nextChannels.find((c) => c._id === id) : null; const targetDm = type === 'dm' ? nextDms.find((d) => d._id === id) : null;
          if (target) void openChannel(target); else if (targetDm) void openDM(targetDm);
          return;
        }
        lastSyncRef.current = response.data.serverTime;
        setMessages((current) => {
          const byId = new Map(current.map((message) => [message._id, message]));
          for (const message of response.data.messages as Message[]) { if (message.isDeleted) byId.delete(message._id); else byId.set(message._id, { ...byId.get(message._id), ...message }); }
          return [...byId.values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a._id.localeCompare(b._id));
        });
        void api.put(type === 'channel' ? '/channels/' + id + '/mark-read' : '/dms/' + id + '/mark-read').catch(() => undefined);
      } catch { /* The next reconnect or conversation open retries. */ }
    };
    const joinRooms = () => { if (hasConnectedRef.current) void resync(); hasConnectedRef.current = true; setSocketConnected(true); socket.emit('workspace:join', workspaceId); if (activeRef.current.type === 'channel' && activeRef.current.id) socket.emit('channel:join', activeRef.current.id); if (activeRef.current.type === 'dm' && activeRef.current.id) socket.emit('dm:join', activeRef.current.id); if (threadRef.current) socket.emit('thread:join', threadRef.current._id); };
    const appendMessage = (message: Message) => {
      if (message.thread?.parentMessage) return;
      const contextType: ActiveType = message.dm ? 'dm' : 'channel'; const contextId = idOf(message.dm || message.channel); const active = activeRef.current;
      if (sameContext(message, active.type, active.id)) {
        setMessages((current) => current.some((item) => item._id === message._id) ? current : [...current, message]);
        // Reading as it arrives (tab visible): persist the read position so unread counts stay right on every device.
        if (message.sender?._id !== user._id && document.visibilityState === 'visible') {
          window.clearTimeout(markReadTimer.current);
          markReadTimer.current = window.setTimeout(() => { const { type, id } = activeRef.current; if (id) void api.put((type === 'channel' ? '/channels/' : '/dms/') + id + '/mark-read').catch(() => undefined); }, 800);
        }
      }
      else if (message.sender?._id !== user._id && contextId) { if (contextType === 'channel') setUnreadChannels((current) => ({ ...current, [contextId]: (current[contextId] || 0) + 1 })); else setUnreadDMs((current) => ({ ...current, [contextId]: (current[contextId] || 0) + 1 })); }
      if (message.sender?._id !== user._id && hasMention(message, user._id) && contextId) { if (contextType === 'channel') setMentionChannels((current) => ({ ...current, [contextId]: (current[contextId] || 0) + 1 })); else setMentionDMs((current) => ({ ...current, [contextId]: (current[contextId] || 0) + 1 })); }
      if (contextType === 'dm' && contextId) setDms((current) => current.map((dm) => dm._id === contextId ? { ...dm, lastMessage: { _id: message._id, content: message.content, sender: message.sender, createdAt: message.createdAt }, lastActivity: message.createdAt } : dm).sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()));
    };
    const appendThreadReply = (message: Message) => {
      const parentId = idOf(message.thread?.parentMessage); if (!parentId) return;
      const currentThread = threadRef.current;
      if (currentThread?._id === parentId) setThreadReplies((current) => current.some((item) => item._id === message._id) ? current : [...current, message]);
      else setThreadUnread((current) => ({ ...current, [parentId]: true }));
    };
    const updateThread = ({ messageId, replyCount, lastReplyAt, participants }: { messageId: string; replyCount: number; lastReplyAt?: string; participants?: string[] }) => {
      setMessages((current) => current.map((message) => message._id === messageId ? { ...message, thread: { ...message.thread, replyCount, lastReplyAt, participants: participants as unknown as User[] } } : message));
      setThreadParent((current) => current?._id === messageId ? { ...current, thread: { ...current.thread, replyCount, lastReplyAt, participants: participants as unknown as User[] } } : current);
    };
    const updateMessage = (message: Message) => { if (message.thread?.parentMessage) setThreadReplies((current) => current.map((item) => item._id === message._id ? message : item)); else if (sameContext(message, activeRef.current.type, activeRef.current.id)) setMessages((current) => current.map((item) => item._id === message._id ? message : item)); };
    const removeMessage = ({ messageId }: { messageId: string }) => { refreshActivity(); setMessages((current) => current.filter((message) => message._id !== messageId)); setThreadReplies((current) => current.filter((message) => message._id !== messageId)); };
    const handleReactionEvent = ({ messageId, reactions }: { messageId: string; reactions: Reaction[] }) => { setMessages((current) => mergeReaction(current, messageId, reactions)); setThreadReplies((current) => mergeReaction(current, messageId, reactions)); setThreadParent((current) => current?._id === messageId ? { ...current, reactions } : current); };
    const handlePinEvent = ({ messageId, isPinned }: { messageId: string; isPinned: boolean }) => { setMessages((current) => current.map((message) => message._id === messageId ? { ...message, isPinned } : message)); setThreadReplies((current) => current.map((message) => message._id === messageId ? { ...message, isPinned } : message)); setThreadParent((current) => current?._id === messageId ? { ...current, isPinned } : current); };
    const addDM = (dm: DirectMessage) => { if (dm.workspace === workspaceId) setDms((current) => current.some((item) => item._id === dm._id) ? current : [dm, ...current]); };
    const addChannel = (channel: Channel) => { if (channel.workspace === workspaceId) setChannels((current) => current.some((item) => item._id === channel._id) ? current : [...current, channel].sort((a, b) => a.name.localeCompare(b.name))); };
    const updatePresence = ({ userId, status, statusMessage }: { userId: string; status: User['status']; statusMessage?: string }) => { setMembers((current) => current.map((member) => member._id === userId ? { ...member, status, statusMessage } : member)); setDms((current) => current.map((dm) => ({ ...dm, participants: dm.participants.map((member) => member._id === userId ? { ...member, status, statusMessage } : member) }))); };
    const updateProfile = ({ userId, ...changes }: { userId: string; displayName: string; avatar: string | null; title: string; statusMessage: string }) => {
      const apply = (member: User) => member._id === userId ? { ...member, ...changes } : member;
      const applyMessage = (message: Message) => message.sender?._id === userId ? { ...message, sender: apply(message.sender) } : message;
      setMembers((current) => current.map(apply));
      setDms((current) => current.map((dm) => ({ ...dm, participants: dm.participants.map(apply), lastMessage: dm.lastMessage?.sender?._id === userId ? { ...dm.lastMessage, sender: apply(dm.lastMessage.sender) } : dm.lastMessage })));
      setMessages((current) => current.map(applyMessage));
      setThreadReplies((current) => current.map(applyMessage));
      setThreadParent((current) => current ? applyMessage(current) : current);
    };
    // The server only relays start/stop events. Each typist expires 5s after their last "start" so a lost "stop"
    // (disconnect, network drop, another server instance) can never leave a stuck "is typing…".
    const typingTimers = typingTimersRef.current;
    const updateTyping = ({ roomType, roomId, userId: typistId, action }: { roomType: string; roomId: string; userId: string; action: 'start' | 'stop' }) => {
      const key = roomType + ':' + roomId; const timerKey = key + '|' + typistId;
      window.clearTimeout(typingTimers.get(timerKey)); typingTimers.delete(timerKey);
      const remove = () => { typingTimers.delete(timerKey); setTypingUsers((current) => ({ ...current, [key]: (current[key] || []).filter((id) => id !== typistId) })); };
      if (action === 'stop') { remove(); return; }
      setTypingUsers((current) => ({ ...current, [key]: (current[key] || []).includes(typistId) ? current[key] : [...(current[key] || []), typistId] }));
      typingTimers.set(timerKey, window.setTimeout(remove, 5000));
    };
    const socketError = () => setSocketConnected(false);
    const notificationWorkspace = (notification: NotificationItem) => idOf(notification.workspace) === workspaceId;
    const onNotificationNew = (notification: NotificationItem) => {
      if (notificationWorkspace(notification)) refreshActivity();
      void showLiveBrowserAlert(notification, notificationSettingsRef.current, {
        workspaceId, type: activeRef.current.type, id: activeRef.current.id, threadId: threadRef.current?._id,
      }).catch(() => undefined);
    };
    let activityTimer: number | undefined;
    const refreshActivity = () => { window.clearTimeout(activityTimer); activityTimer = window.setTimeout(() => void loadActivityCount().catch(() => undefined), 150); };
    const onNotificationRead = () => refreshActivity();
    const onActivityChanged = ({ workspaceId: changed }: { workspaceId?: string }) => { if (!changed || changed === workspaceId) refreshActivity(); };
    socket.on('activity:changed', onActivityChanged);
    const onSavedChanged = () => { void loadSavedMessages().catch(() => undefined); window.dispatchEvent(new CustomEvent('unichat:saved-refresh')); };
    socket.on('saved:changed', onSavedChanged);
    const onWorkspaceDeleted = ({ workspaceId: removed }: { workspaceId: string }) => { if (removed === workspaceId) navigate('/workspaces', { replace: true }); };
    const onWorkspaceUpdated = (updated: Workspace) => { if (updated._id === workspaceId) setWorkspace((current) => current ? { ...current, name: updated.name, description: updated.description, icon: updated.icon } : current); };
    const onMemberJoined = async ({ workspaceId: changed }: { workspaceId: string }) => {
      if (changed !== workspaceId) return;
      try {
        const { data } = await api.get('/workspaces/' + workspaceId);
        setWorkspace(current => current?._id === changed ? data.workspace : current);
        if (socketRef.current === socket) setMembers((data.workspace.members || []).map((member: any) => member.user).filter(Boolean));
      } catch { /* The next workspace load retries member synchronization. */ }
    };
    socket.on('workspace:member_joined', onMemberJoined);
    // ---- Membership / management events (kept in sync without a page refresh) ----
    const reloadLists = async () => {
      try {
        const [channelResponse, dmResponse] = await Promise.all([api.get('/channels/workspace/' + workspaceId), api.get('/dms?workspaceId=' + workspaceId)]);
        if (workspaceIdRef.current !== workspaceId) return;
        setChannels(channelResponse.data.channels as Channel[]); setDms(dmResponse.data.dms as DirectMessage[]);
      } catch { /* the next event or reconnect retries */ }
    };
    const leaveActiveIf = (type: ActiveType, id: string) => {
      if (activeRef.current.type !== type || activeRef.current.id !== id) return;
      socket.emit(type === 'channel' ? 'channel:leave' : 'dm:leave', id);
      closeThread(); setMessages([]); setActiveId(undefined); activeRef.current = { type, id: undefined };
      setShowDetails(false);
    };
    const onChannelInvited = () => void reloadLists();
    const onChannelRemoved = ({ channelId }: { channelId: string }) => { setChannels((current) => current.filter((c) => c._id !== channelId)); leaveActiveIf('channel', channelId); void reloadLists(); /* a public channel reappears as joinable; a private one stays gone */ };
    const onChannelArchived = ({ channelId }: { channelId: string }) => { setChannels((current) => current.filter((c) => c._id !== channelId)); leaveActiveIf('channel', channelId); };
    const onChannelUpdated = (updated: Channel) => { if (updated.workspace === workspaceId) setChannels((current) => { const known = current.some((c) => c._id === updated._id); const merged = known ? current.map((c) => c._id === updated._id ? { ...c, name: updated.name, description: updated.description, ...(updated as any).topic !== undefined ? { topic: (updated as any).topic } : {}, members: updated.members ?? c.members } : c) : current; return [...merged].sort((a, b) => a.name.localeCompare(b.name)); }); };
    const onChannelMembers = ({ channelId, userId, joined }: { channelId: string; userId: string; joined: boolean }) => setChannels((current) => current.map((c) => c._id !== channelId ? c : { ...c, isMember: userId === user._id ? joined : c.isMember, members: joined ? [...(c.members || []).filter((m) => idOf(m.user) !== userId), { user: userId }] : (c.members || []).filter((m) => idOf(m.user) !== userId) }));
    const onDmUpdated = (updated: DirectMessage) => setDms((current) => current.map((d) => d._id === updated._id ? { ...d, ...updated, unreadCount: d.unreadCount, mentionCount: d.mentionCount } : d));
    const onDmRemoved = ({ dmId }: { dmId: string }) => { setDms((current) => current.filter((d) => d._id !== dmId)); leaveActiveIf('dm', dmId); };
    const onWorkspaceRemoved = ({ workspaceId: removed }: { workspaceId: string }) => { if (removed === workspaceId) navigate('/workspaces', { replace: true }); };
    const onRolesChanged = ({ workspaceId: changed }: { workspaceId: string }) => { if (changed === workspaceId) void onMemberJoined({ workspaceId: changed }); };
    // Read position changed on another device of this user.
    const onChannelRead = ({ channelId }: { channelId: string }) => { setUnreadChannels((current) => { const next = { ...current }; delete next[channelId]; return next; }); setMentionChannels((current) => { const next = { ...current }; delete next[channelId]; return next; }); setChannels((current) => current.map((c) => c._id === channelId ? { ...c, unreadCount: 0, mentionCount: 0 } : c)); };
    const onDmRead = ({ dmId, userId: reader }: { dmId: string; userId: string }) => { if (reader !== user._id) return; setUnreadDMs((current) => { const next = { ...current }; delete next[dmId]; return next; }); setMentionDMs((current) => { const next = { ...current }; delete next[dmId]; return next; }); setDms((current) => current.map((d) => d._id === dmId ? { ...d, unreadCount: 0, mentionCount: 0 } : d)); };
    const onSocketMemberJoined = ({ channelId, userId }: { channelId: string; userId: string }) => onChannelMembers({ channelId, userId, joined: true });
    const onSocketMemberLeft = ({ channelId, userId }: { channelId: string; userId: string }) => onChannelMembers({ channelId, userId, joined: false });
    socket.on('channel:invited', onChannelInvited); socket.on('channel:removed', onChannelRemoved); socket.on('channel:archived', onChannelArchived); socket.on('channel:updated', onChannelUpdated);
    socket.on('channel:member_joined', onSocketMemberJoined); socket.on('channel:member_left', onSocketMemberLeft); socket.on('dm:updated', onDmUpdated); socket.on('dm:removed', onDmRemoved);
    socket.on('workspace:removed', onWorkspaceRemoved); socket.on('workspace:member_left', onRolesChanged); socket.on('workspace:member_updated', onRolesChanged); socket.on('workspace:ownership_transferred', onRolesChanged);
    socket.on('channel:read', onChannelRead); socket.on('dm:read', onDmRead);

    socket.on('workspace:deleted', onWorkspaceDeleted); socket.on('workspace:updated', onWorkspaceUpdated);
    const onNotificationReadAll = ({ workspaceId: eventWorkspace }: { workspaceId?: string | null }) => { if (!eventWorkspace || eventWorkspace === workspaceId) refreshActivity(); };
    socket.on('connect', joinRooms); socket.on('disconnect', socketError); socket.on('connect_error', socketError); socket.on('message:new', appendMessage); socket.on('thread:new', appendThreadReply); socket.on('message:thread_updated', updateThread); socket.on('message:updated', updateMessage); socket.on('message:deleted', removeMessage); socket.on('message:reaction', handleReactionEvent); socket.on('message:pinned', handlePinEvent); socket.on('dm:created', addDM); socket.on('channel:created', addChannel); socket.on('typing:update', updateTyping); socket.on('user:presence_update', updatePresence); socket.on('user:profile_updated', updateProfile); socket.on('notification:new', onNotificationNew); socket.on('notification:read', onNotificationRead); socket.on('notification:read_all', onNotificationReadAll); if (socket.connected) joinRooms();
    return () => { window.clearTimeout(markReadTimer.current); typingTimers.forEach((handle) => window.clearTimeout(handle)); typingTimers.clear(); window.clearTimeout(activityTimer); socket.off('activity:changed', onActivityChanged); socket.off('saved:changed', onSavedChanged); socket.off('workspace:member_joined', onMemberJoined); socket.off('channel:invited', onChannelInvited); socket.off('channel:removed', onChannelRemoved); socket.off('channel:archived', onChannelArchived); socket.off('channel:updated', onChannelUpdated); socket.off('channel:member_joined', onSocketMemberJoined); socket.off('channel:member_left', onSocketMemberLeft); socket.off('dm:updated', onDmUpdated); socket.off('dm:removed', onDmRemoved); socket.off('workspace:removed', onWorkspaceRemoved); socket.off('workspace:member_left', onRolesChanged); socket.off('workspace:member_updated', onRolesChanged); socket.off('workspace:ownership_transferred', onRolesChanged); socket.off('channel:read', onChannelRead); socket.off('dm:read', onDmRead); socket.off('workspace:deleted', onWorkspaceDeleted); socket.off('workspace:updated', onWorkspaceUpdated); socket.off('connect', joinRooms); socket.off('disconnect', socketError); socket.off('connect_error', socketError); socket.off('message:new', appendMessage); socket.off('thread:new', appendThreadReply); socket.off('message:thread_updated', updateThread); socket.off('message:updated', updateMessage); socket.off('message:deleted', removeMessage); socket.off('message:reaction', handleReactionEvent); socket.off('message:pinned', handlePinEvent); socket.off('dm:created', addDM); socket.off('channel:created', addChannel); socket.off('typing:update', updateTyping); socket.off('user:presence_update', updatePresence); socket.off('user:profile_updated', updateProfile); socket.off('notification:new', onNotificationNew); socket.off('notification:read', onNotificationRead); socket.off('notification:read_all', onNotificationReadAll); disconnectSocket(); socketRef.current = null; };
  }, [workspaceId, user?._id]);

  const joinActiveChannel = async () => {
    if (!activeChannel) return;
    setJoiningChannel(true);
    try { await api.post('/channels/' + activeChannel._id + '/join'); setChannels((current) => current.map((c) => c._id === activeChannel._id ? { ...c, isMember: true } : c)); socketRef.current?.emit('channel:join', activeChannel._id); setMessageError(''); }
    catch (err: any) { setMessageError(err.response?.data?.error || 'Unable to join channel'); }
    finally { setJoiningChannel(false); }
  };
  const afterLeavingConversation = async () => {
    setShowDetails(false);
    const response = await api.get('/channels/workspace/' + workspaceId).catch(() => null);
    const next = (response?.data.channels as Channel[] | undefined) ?? [];
    setChannels(next);
    const fallback = next.find((c) => c.name === 'general') || next[0];
    if (fallback) void openChannel(fallback); else { setActiveId(undefined); setMessages([]); }
  };
  const createChannel = async (name: string, description: string, type: 'public' | 'private') => { if (!workspaceId) return; try { const response = await api.post('/channels', { workspaceId, name, description, type }); setChannels((current) => [...current.filter((channel) => channel._id !== response.data.channel._id), response.data.channel].sort((a, b) => a.name.localeCompare(b.name))); setShowCreateChannel(false); await openChannel(response.data.channel); } catch (err: any) { setMessageError(err.response?.data?.error || 'Unable to create channel'); } };
  const createDM = async (participantIds: string[], isGroup: boolean) => { if (!workspaceId) return; try { const response = await api.post('/dms', { workspaceId, participantIds, isGroup }); setDms((current) => current.some((item) => item._id === response.data.dm._id) ? current : [response.data.dm, ...current]); setShowNewMessage(false); await openDM(response.data.dm); } catch (err: any) { setMessageError(err.response?.data?.error || 'Unable to start conversation'); } };
  const sendMessage = async (content: string, attachments: Attachment[], formattedContent?: string) => { if (!workspaceId || !activeId) return; try { const response = await postMessage({ workspaceId, content, formattedContent, attachmentIds: attachments.map((attachment) => attachment.uploadId).filter(Boolean), ...(activeType === 'channel' ? { channelId: activeId } : { dmId: activeId }) }); if (response.data.message && sameContext(response.data.message, activeRef.current.type, activeRef.current.id)) setMessages((current) => current.some((item) => item._id === response.data.message._id) ? current : [...current, response.data.message]); setMessageError(''); } catch (err: any) { throw new Error(err.response?.data?.error || 'Unable to send message'); } };
  const sendThreadReply = async (content: string, attachments: Attachment[], formattedContent?: string) => { if (!workspaceId || !threadParent) return; const channelId = idOf(threadParent.channel); const dmId = idOf(threadParent.dm); try { const response = await postMessage({ workspaceId, content, formattedContent, attachmentIds: attachments.map((attachment) => attachment.uploadId).filter(Boolean), parentMessageId: threadParent._id, ...(channelId ? { channelId } : { dmId }) }); if (response.data.message && threadRef.current?._id === threadParent._id) setThreadReplies((current) => current.some((item) => item._id === response.data.message._id) ? current : [...current, response.data.message]); } catch (err: any) { throw new Error(err.response?.data?.error || 'Unable to send thread reply'); } };
  const saveMessage = async (message: Message) => {
    try {
      if (savedMessageIds.has(message._id)) {
        await api.delete('/saved/' + message._id);
        setSavedMessageIds((current) => { const next = new Set(current); next.delete(message._id); return next; });
        window.dispatchEvent(new CustomEvent('unichat:saved-changed', { detail: { messageId: message._id, saved: false } }));
        window.dispatchEvent(new CustomEvent('unichat:saved-refresh'));
      } else {
        await api.post('/saved', { workspaceId, messageId: message._id });
        setSavedMessageIds((current) => new Set(current).add(message._id));
        window.dispatchEvent(new CustomEvent('unichat:saved-changed', { detail: { messageId: message._id, saved: true } }));
        window.dispatchEvent(new CustomEvent('unichat:saved-refresh'));
      }
    } catch (err: any) { setMessageError(err.response?.data?.error || 'Unable to update saved message'); }
  };
  const pinMessage = async (message: Message, currentlyPinned: boolean) => {
    try {
      const response = currentlyPinned ? await api.delete('/messages/' + message._id + '/pin') : await api.post('/messages/' + message._id + '/pin');
      const isPinned = Boolean(response.data.isPinned);
      const update = (items: Message[]) => items.map((item) => item._id === message._id ? { ...item, isPinned } : item);
      setMessages(update); setThreadReplies(update); setThreadParent((current) => current?._id === message._id ? { ...current, isPinned } : current);
      window.dispatchEvent(new CustomEvent('unichat:focus-message', { detail: { messageId: message._id } }));
    } catch (err: any) { setMessageError(err.response?.data?.error || 'Unable to update pinned message'); }
  };
  const forwardMessage = async (message: Message, target: ForwardTarget) => {
    try {
      const response = await api.post('/messages/' + message._id + '/forward', target.type === 'channel' ? { channelId: target.id } : { dmId: target.id });
      const forwarded = response.data.message as Message;
      if (forwarded) {
        const sourceChannel = channels.find((channel) => channel._id === activeId);
        const sourceDM = dms.find((dm) => dm._id === activeId);
        const existingAttribution = message.forwardedFrom;
        const forwardedFrom = {
          ...forwarded.forwardedFrom,
          senderName: existingAttribution?.senderName?.trim() || message.sender?.displayName?.trim() || message.sender?.username || 'Unknown sender',
          conversationName: existingAttribution?.conversationName?.trim() || (activeType === 'channel'
            ? `#${sourceChannel?.name || 'channel'}`
            : sourceDM?.isGroup ? sourceDM.groupName || 'Group message' : 'Direct message'),
          createdAt: existingAttribution?.createdAt || message.createdAt,
          isThreadReply: existingAttribution?.isThreadReply ?? Boolean(message.thread?.parentMessage),
        };
        const completeForward = { ...forwarded, forwardedFrom };
        if (sameContext(completeForward, activeType, activeId)) {
          setMessages((current) => {
            const existingIndex = current.findIndex((item) => item._id === completeForward._id);
            if (existingIndex < 0) return [...current, completeForward];
            return current.map((item) => item._id === completeForward._id ? { ...item, ...completeForward } : item);
          });
        }
      }
      setForwardingMessage(null);
      setMessageError('');
    } catch (err: any) {
      throw new Error(err.response?.data?.error || 'Unable to forward message');
    }
  };
  const openSearchResult = async (result: SearchResult) => {
    const channelId = typeof result.channel === 'string' ? result.channel : result.channel?._id;
    const dmId = typeof result.dm === 'string' ? result.dm : result.dm?._id;
    try {
      if (channelId) {
        const channel = channels.find((item) => item._id === channelId);
        if (!channel) throw new Error('Conversation is no longer available');
        await openChannel(channel);
      } else if (dmId) {
        const dm = dms.find((item) => item._id === dmId);
        if (!dm) throw new Error('Conversation is no longer available');
        await openDM(dm);
      }
      if (result.threadParentId) {
        const threadResponse = await api.get('/messages/' + result.threadParentId + '/thread');
        await openThread(threadResponse.data.parent);
      } else window.dispatchEvent(new CustomEvent('unichat:focus-message', { detail: { messageId: result._id } }));
    } catch (err: any) { setMessageError(err.response?.data?.error || 'Unable to open search result'); }
  };
  const openSavedItem = async (item: SavedMessage) => {
    const channel = item.channel?._id ? channels.find((candidate) => candidate._id === item.channel?._id) : undefined;
    const dm = item.dm?._id ? dms.find((candidate) => candidate._id === item.dm?._id) : undefined;
    if (channel) await openChannel(channel);
    else if (dm) await openDM(dm);
    window.dispatchEvent(new CustomEvent('unichat:focus-message', { detail: { messageId: item.message._id } }));
  };
  const openPinnedItem = async (item: PinnedMessage) => { window.dispatchEvent(new CustomEvent('unichat:focus-message', { detail: { messageId: item.message._id } })); };
  const openActivityItem = useCallback(async (item: NotificationItem) => {
    if (item.type === 'workspace_join_request') { navigate(`/workspaces?review=${idOf(item.workspace)}`); return; }
    if (item.type === 'workspace_join_approved') { navigate(`/chat/${idOf(item.workspace)}`); return; }
    if (['password_recovery', 'security_alert', 'admin_alert'].includes(item.type)) { navigate(`/admin?tab=password-resets&requestId=${encodeURIComponent(item.metadata?.requestId || '')}`); return; }
    const channelId = item.channel?._id;
    const dmId = item.dm?._id;
    try {
      if (channelId) {
        const channel = channels.find((candidate) => candidate._id === channelId);
        if (!channel) throw new Error('This channel is no longer available');
        await openChannel(channel);
      } else if (dmId) {
        const dm = dms.find((candidate) => candidate._id === dmId);
        if (!dm) throw new Error('This conversation is no longer available');
        await openDM(dm);
      }
      const parentId = idOf(item.threadParent) || idOf(item.message?.thread?.parentMessage);
      if (parentId) {
        const threadResponse = await api.get('/messages/' + parentId + '/thread');
        await openThread(threadResponse.data.parent);
      }
      if (item.message?._id) window.setTimeout(() => window.dispatchEvent(new CustomEvent('unichat:focus-message', { detail: { messageId: item.message?._id } })), 0);
    } catch (err: any) {
      setMessageError(err.response?.data?.error || 'Unable to open activity');
    }
  }, [channels, dms, openChannel, openDM, openThread]);
  useEffect(() => {
    const onSave = (event: Event) => void saveMessage((event as CustomEvent<Message>).detail);
    const onPin = (event: Event) => { const detail = (event as CustomEvent<{ message: Message; pinned: boolean }>).detail; void pinMessage(detail.message, detail.pinned); };
    const onSearchResult = (event: Event) => void openSearchResult((event as CustomEvent<SearchResult>).detail);
    const onSavedItem = (event: Event) => void openSavedItem((event as CustomEvent<SavedMessage>).detail);
    const onPinnedItem = (event: Event) => void openPinnedItem((event as CustomEvent<PinnedMessage>).detail);
    const onUnsave = (event: Event) => void saveMessage((event as CustomEvent<Message>).detail);
    const onActivityItem = (event: Event) => void openActivityItem((event as CustomEvent<NotificationItem>).detail);
    window.addEventListener('unichat:save', onSave); window.addEventListener('unichat:pin', onPin); window.addEventListener('unichat:search-result', onSearchResult); window.addEventListener('unichat:saved-item', onSavedItem); window.addEventListener('unichat:pinned-item', onPinnedItem); window.addEventListener('unichat:unsave', onUnsave); window.addEventListener('unichat:activity-item', onActivityItem);
    return () => { window.removeEventListener('unichat:save', onSave); window.removeEventListener('unichat:pin', onPin); window.removeEventListener('unichat:search-result', onSearchResult); window.removeEventListener('unichat:saved-item', onSavedItem); window.removeEventListener('unichat:pinned-item', onPinnedItem); window.removeEventListener('unichat:unsave', onUnsave); window.removeEventListener('unichat:activity-item', onActivityItem); };
  }, [saveMessage, pinMessage, openSearchResult, openSavedItem, openPinnedItem, openActivityItem]);
  useEffect(() => { window.dispatchEvent(new CustomEvent('unichat:pin-capable', { detail: { canPin: activeType === 'channel' && Boolean(activeChannel?.canPin) } })); }, [activeType, activeChannel?.canPin]);
  const editMessage = async (message: Message, content: string, formattedContent?: string) => { try { const response = await api.put('/messages/' + message._id, { content, formattedContent }); if (response.data.message) { setMessages((current) => current.map((item) => item._id === message._id ? response.data.message : item)); setThreadReplies((current) => current.map((item) => item._id === message._id ? response.data.message : item)); setThreadParent((current) => current?._id === message._id ? response.data.message : current); } } catch (err: any) { throw new Error(err.response?.data?.error || 'Unable to edit message'); } };
  const deleteMessage = async (message: Message) => { try { await api.delete('/messages/' + message._id); setMessages((current) => current.filter((item) => item._id !== message._id)); setThreadReplies((current) => current.filter((item) => item._id !== message._id)); setSavedMessageIds((current) => { const next = new Set(current); next.delete(message._id); return next; }); window.dispatchEvent(new CustomEvent('unichat:saved-changed', { detail: { messageId: message._id, saved: false } })); } catch (err: any) { throw new Error(err.response?.data?.error || 'Unable to delete message'); } };
  const reactToMessage = async (message: Message, emoji: string, selected = false) => { try { const response = selected ? await api.delete('/messages/' + message._id + '/react', { data: { emoji } }) : await api.post('/messages/' + message._id + '/react', { emoji }); const reactions = response.data.reactions as Reaction[]; setMessages((current) => mergeReaction(current, message._id, reactions)); setThreadReplies((current) => mergeReaction(current, message._id, reactions)); setThreadParent((current) => current?._id === message._id ? { ...current, reactions } : current); } catch (err: any) { setMessageError(err.response?.data?.error || 'Unable to update reaction'); } };
  const emitTyping = (typing: boolean) => { if (activeId) socketRef.current?.emit(typing ? 'typing:start' : 'typing:stop', { roomType: activeType, roomId: activeId }); };
  const emitThreadTyping = (typing: boolean) => { if (threadParent) socketRef.current?.emit(typing ? 'typing:start' : 'typing:stop', { roomType: 'thread', roomId: threadParent._id }); };
  const messageUser = (target: User) => { if (target._id !== user?._id) void createDM([target._id], false); };

  if (!user || !workspace) return <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-[var(--background)] px-6 text-center text-[var(--text)]">{error ? <><h1 className="text-xl font-semibold">This workspace is unavailable</h1><p role="alert" className="text-sm text-[var(--text-secondary)]">{error}</p><div className="flex gap-3"><button className="ui-primary-button px-4 py-2 text-sm" onClick={() => navigate('/workspaces')}>Your workspaces</button><button className="ui-secondary-button px-4 py-2 text-sm" onClick={() => window.location.reload()}>Try again</button></div></> : <p role="status" className="text-sm text-[var(--text-secondary)]">Loading Unichat…</p>}</main>;
  const currentWorkspaceId = workspaceId || workspace._id;
  const activeConversation = activeType === 'channel' ? activeChannel : activeDM;
  const conversationTitle = activeType === 'channel' ? `Message #${activeChannel?.name || 'channel'}` : `Message ${activeDM ? dmTitle(activeDM, user._id) : 'conversation'}`;
  const emptyLabel = activeType === 'channel' ? `This is the beginning of #${activeChannel?.name || 'this channel'}.` : `This is the beginning of your conversation with ${activeDM ? dmTitle(activeDM, user._id) : 'this person'}.`;
  const visibleMessages = conversationView === 'files' ? messages.filter((message) => Boolean(message.attachments?.length)) : messages;
  return <AppShell user={user} workspace={workspace} workspaces={workspaces} channels={channels} dms={dms} activeType={activeType} activeId={activeId} unreadChannels={unreadChannels} unreadDMs={unreadDMs} mentionChannels={mentionChannels} mentionDMs={mentionDMs} workspaceHasUnread={workspaceHasUnread} socketConnected={socketConnected} onWorkspace={(id) => navigate('/chat/' + id)} onAddWorkspace={() => navigate('/workspaces')} onChannel={(channel) => void openChannel(channel)} onDM={(dm) => void openDM(dm)} onCreateChannel={() => setShowCreateChannel(true)} onNewMessage={() => setShowNewMessage(true)} onOpenMembers={() => setShowMembers(true)} onLogout={logout}>
    <div className="chat-content-frame flex min-w-0 flex-1">
      <main className="flex min-w-0 flex-1 flex-col bg-[var(--background)]">
        {!socketConnected && <div className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-xs text-amber-800" role="status">Connection lost. Reconnecting…</div>}
        {loading && <div className="border-b border-slate-200 bg-white px-6 py-2 text-xs text-slate-400">Switching workspace…</div>}
        {error && <div className="m-4 border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700" role="alert">{error}</div>}
        {messageError && <div className="mx-6 mt-3 border border-red-200 bg-red-50 px-6 py-2 text-xs text-red-700" role="alert">{messageError}</div>}
        {activeConversation ? <>
          <ConversationHeader key={`${activeType}:${activeId}`} type={activeType} channel={activeChannel} dm={activeDM} currentUser={user} view={conversationView} onViewChange={setConversationView} onOpenDetails={(activeType === 'channel' || activeDM?.isGroup) ? () => setShowDetails(true) : undefined} />
          {loadingConversation ? <div className="flex flex-1 items-center justify-center"><span className="text-xs text-slate-400">Loading conversation…</span></div> : <section className="flex min-h-0 flex-1 flex-col" aria-label={conversationView === 'files' ? 'Files and links' : 'Messages'}>
            <MessageList workspaceId={currentWorkspaceId} messages={visibleMessages} currentUserId={user._id} members={members} contextMemberIds={activeContextMemberIds} contextType={activeType} lastReadAt={conversationView === 'messages' ? lastReadAt : null} emptyLabel={conversationView === 'files' ? 'No files or links in the messages currently loaded for this conversation.' : emptyLabel} threadUnread={threadUnread} canPin={activeType === 'channel' && Boolean(activeChannel?.canPin)} onPin={pinMessage} onForward={setForwardingMessage} onEdit={editMessage} onDelete={deleteMessage} onReact={reactToMessage} onOpenThread={openThread} onMessageUser={messageUser} hasMoreOlder={conversationView === 'messages' && hasMoreOlder} loadingOlder={loadingOlder} onLoadOlder={() => void loadOlder()} />
          </section>}
          {activeType === 'channel' && activeChannel && !activeChannel.isMember
            ? <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] bg-[var(--surface)] px-6 py-3 text-sm"><span className="text-[var(--text-secondary)]">You are previewing <strong>#{activeChannel.name}</strong>. Join to send messages.</span><button type="button" disabled={joiningChannel} onClick={() => void joinActiveChannel()} className="ui-primary-button px-4 py-1.5 text-xs">{joiningChannel ? 'Joining…' : 'Join channel'}</button></div>
            : <MessageComposer placeholder={conversationTitle} typingText={typingText} members={members} contextMemberIds={activeContextMemberIds} contextType={activeType} workspaceId={currentWorkspaceId} {...(activeType === 'channel' ? { channelId: activeId } : { dmId: activeId })} disabled={!activeId} onSend={sendMessage} onTyping={emitTyping} />}
        </> : <EmptyState title="No conversation selected" description="Choose a channel or start a new direct message." />}
      </main>
      {threadParent && <ThreadPanel parent={threadParent} replies={threadReplies} currentUserId={user._id} members={members} contextMemberIds={activeContextMemberIds} contextType={activeType} workspaceId={currentWorkspaceId} channelId={idOf(threadParent.channel)} dmId={idOf(threadParent.dm)} loading={threadLoading} error={threadError} typingText={threadTypingText} onClose={closeThread} onSend={sendThreadReply} onTyping={emitThreadTyping} onEdit={editMessage} onDelete={deleteMessage} onReact={reactToMessage} onForward={setForwardingMessage} />}
    </div>
    {showNewMessage && <NewMessageModal members={members} currentUserId={user._id} onClose={() => setShowNewMessage(false)} onCreate={createDM} />}
    {forwardingMessage && <ForwardMessageModal message={forwardingMessage} channels={channels} dms={dms} currentUserId={user._id} onClose={() => setForwardingMessage(null)} onForward={(target) => forwardMessage(forwardingMessage, target)} />}
    {showDetails && activeType === 'channel' && activeChannel && <ChannelDetailsModal channelId={activeChannel._id} workspaceMembers={members} currentUserId={user._id} onClose={() => setShowDetails(false)} onLeft={() => void afterLeavingConversation()} onChanged={() => void api.get('/channels/workspace/' + workspaceId).then((r) => setChannels(r.data.channels)).catch(() => undefined)} />}
    {showDetails && activeType === 'dm' && activeDM?.isGroup && <GroupDetailsModal dm={activeDM} workspaceMembers={members} currentUserId={user._id} onClose={() => setShowDetails(false)} onLeft={() => { setShowDetails(false); setDms((c) => c.filter((d) => d._id !== activeDM._id)); setActiveId(undefined); setMessages([]); }} />}
    {showMembers && <WorkspaceMembersModal workspaceId={currentWorkspaceId} workspaceName={workspace.name} currentUserId={user._id} onClose={() => setShowMembers(false)} onLeft={() => navigate('/workspaces', { replace: true })} onChanged={() => void api.get('/workspaces/' + workspaceId).then((r) => { setWorkspace(r.data.workspace); setMembers((r.data.workspace.members || []).map((m: any) => m.user).filter(Boolean)); }).catch(() => undefined)} />}
    {showCreateChannel && <CreateChannelModal onClose={() => setShowCreateChannel(false)} onCreate={createChannel} />}
  </AppShell>;
}
