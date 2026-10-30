import { useMessageReadReceipts } from '../../hooks/useMessageReadReceipts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Message, User } from '../../types';
import MessageItem from './MessageItem';
import { isGroupedMessage } from '../../utils/messageGrouping';

interface Props {
  workspaceId: string;
  messages: Message[];
  currentUserId: string;
  members: User[];
  lastReadAt?: string | null;
  emptyLabel?: string;
  threadUnread?: Record<string, boolean>;
  onEdit: (message: Message, content: string, formattedContent?: string) => Promise<void>;
  onDelete: (message: Message) => Promise<void>;
  onReact: (message: Message, emoji: string, selected?: boolean) => Promise<void>;
  onOpenThread: (message: Message) => void;
  onMessageUser?: (user: Message['sender']) => void;
  savedMessageIds?: Set<string>;
  canPin?: boolean;
  onSave?: (message: Message) => Promise<void>;
  onPin?: (message: Message, pinned: boolean) => Promise<void>;
  onForward: (message: Message) => void;
  focusMessageId?: string | null;
  contextMemberIds?: string[];
  contextType?: 'channel' | 'dm';
  hasMoreOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
}

export default function MessageList({ workspaceId, messages, currentUserId, members, lastReadAt, emptyLabel = 'This is the beginning of this conversation.', threadUnread = {}, onEdit, onDelete, onReact, onOpenThread, onMessageUser, savedMessageIds, canPin = false, onSave, onPin, onForward, focusMessageId, contextMemberIds = [], contextType, hasMoreOlder = false, loadingOlder = false, onLoadOlder }: Props) {
  const readContainer = useMessageReadReceipts(workspaceId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [eventSavedIds, setEventSavedIds] = useState<Set<string>>(new Set());
  const [eventCanPin, setEventCanPin] = useState(false);
  const [eventFocusId, setEventFocusId] = useState<string | null>(null);
  const focusTimerRef = useRef<number | null>(null);
  const effectiveSavedIds = savedMessageIds || eventSavedIds;
  const effectiveCanPin = canPin || eventCanPin;
  const save = onSave || ((message: Message) => { window.dispatchEvent(new CustomEvent('unichat:save', { detail: message })); return Promise.resolve(); });
  const pin = onPin || ((message: Message, pinned: boolean) => { window.dispatchEvent(new CustomEvent('unichat:pin', { detail: { message, pinned } })); return Promise.resolve(); });
  // Scroll behaviour: keep the viewport anchored when older history is prepended, follow new messages
  // only when the reader is already near the bottom (or sent them), and jump instantly on conversation switch.
  const topSentinel = useRef<HTMLDivElement>(null);
  const scrollState = useRef({ firstId: undefined as string | undefined, lastId: undefined as string | undefined, height: 0, nearBottom: true });
  useLayoutEffect(() => {
    const el = readContainer.current; if (!el) return;
    const state = scrollState.current; const first = messages[0]?._id; const last = messages[messages.length - 1]?._id;
    const prepended = state.firstId && first !== state.firstId && messages.some((m) => m._id === state.firstId);
    if (prepended && last === state.lastId) {
      el.scrollTop += el.scrollHeight - state.height;
    } else if (last !== state.lastId) {
      const continuing = Boolean(state.lastId) && messages.some((m) => m._id === state.lastId);
      const mine = messages[messages.length - 1]?.sender?._id === currentUserId;
      if (!continuing) el.scrollTop = el.scrollHeight;
      else if (state.nearBottom || mine) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    state.firstId = first; state.lastId = last; state.height = el.scrollHeight;
  }, [messages]);
  useEffect(() => {
    const el = readContainer.current; if (!el) return undefined;
    const onScroll = () => { scrollState.current.nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240; };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    const el = readContainer.current; const sentinel = topSentinel.current;
    if (!el || !sentinel || !hasMoreOlder || loadingOlder || !onLoadOlder) return undefined;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) onLoadOlder(); }, { root: el, rootMargin: '200px 0px 0px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMoreOlder, loadingOlder, onLoadOlder, messages.length]);
  useEffect(() => { if (focusMessageId || eventFocusId) document.getElementById(`message-${focusMessageId || eventFocusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [focusMessageId, eventFocusId, messages.length]);
  useEffect(() => {
    const onState = (event: Event) => setEventSavedIds(new Set((event as CustomEvent<{ ids: string[] }>).detail.ids));
    const onChanged = (event: Event) => setEventSavedIds((current) => { const next = new Set(current); const { messageId, saved } = (event as CustomEvent<{ messageId: string; saved: boolean }>).detail; if (saved) next.add(messageId); else next.delete(messageId); return next; });
    const onCapability = (event: Event) => setEventCanPin(Boolean((event as CustomEvent<{ canPin: boolean }>).detail.canPin));
    const onFocus = (event: Event) => { const messageId = (event as CustomEvent<{ messageId: string }>).detail.messageId; setEventFocusId(messageId); if (focusTimerRef.current) window.clearTimeout(focusTimerRef.current); focusTimerRef.current = window.setTimeout(() => setEventFocusId(null), 2800); };
    window.addEventListener('unichat:saved-state', onState); window.addEventListener('unichat:saved-changed', onChanged); window.addEventListener('unichat:pin-capable', onCapability); window.addEventListener('unichat:focus-message', onFocus);
    return () => { window.removeEventListener('unichat:saved-state', onState); window.removeEventListener('unichat:saved-changed', onChanged); window.removeEventListener('unichat:pin-capable', onCapability); window.removeEventListener('unichat:focus-message', onFocus); if (focusTimerRef.current) window.clearTimeout(focusTimerRef.current); };
  }, []);

  let dividerShown = false;
  return <div ref={readContainer} style={{ overflowAnchor: 'none' }} className="flex-1 overflow-y-auto bg-[var(--surface-main)] px-4 py-5 sm:px-6">
    {messages.length === 0 && <div className="flex h-full items-center justify-center text-xs text-[var(--text-muted)]">{emptyLabel}</div>}
    <div ref={topSentinel} className="h-px" aria-hidden />
    {(hasMoreOlder || loadingOlder) && <div className="mb-3 flex justify-center"><button type="button" disabled={loadingOlder} onClick={onLoadOlder} className="ui-secondary-button px-3 py-1 text-[11px]">{loadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}</button></div>}
    <div>{messages.map((message, index) => {
      const isNew = Boolean(lastReadAt && new Date(message.createdAt) > new Date(lastReadAt) && message.sender?._id !== currentUserId);
      const showDivider = isNew && !dividerShown;
      const grouped = !showDivider && isGroupedMessage(messages[index - 1], message);
      if (showDivider) dividerShown = true;
      return <div key={message._id} className={!grouped && index > 0 && !showDivider ? 'message-group-start' : undefined}>{showDivider && <div className="my-4 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--primary)]"><span className="h-px flex-1 bg-[var(--border-strong)]" /> New messages <span className="h-px flex-1 bg-[var(--border-strong)]" /></div>}<MessageItem workspaceId={workspaceId} message={message} grouped={grouped} currentUserId={currentUserId} members={members} contextMemberIds={contextMemberIds} contextType={contextType} threadUnread={Boolean(threadUnread[message._id])} onEdit={onEdit} onDelete={onDelete} onReact={onReact} onOpenThread={onOpenThread} onMessageUser={onMessageUser} isSaved={effectiveSavedIds.has(message._id)} canPin={effectiveCanPin} onSave={save} onPin={pin} onForward={onForward} isFocused={message._id === (focusMessageId || eventFocusId)} /></div>;
    })}</div>
    <div ref={bottomRef} />
  </div>;
}
