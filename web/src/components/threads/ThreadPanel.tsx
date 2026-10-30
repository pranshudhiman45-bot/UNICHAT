import { useMessageReadReceipts } from '../../hooks/useMessageReadReceipts';
import { useEffect, useState } from 'react';
import type { Attachment, Message, User } from '../../types';
import Avatar from '../common/Avatar';
import MessageComposer from '../messages/MessageComposer';
import MessageItem from '../messages/MessageItem';
import RichMessageContent from '../messages/RichMessageContent';
import AttachmentDisplay from '../messages/AttachmentDisplay';

interface Props {
  parent: Message;
  replies: Message[];
  currentUserId: string;
  members: User[];
  loading?: boolean;
  error?: string;
  typingText?: string;
  onClose: () => void;
  onSend: (content: string, attachments: Attachment[], formattedContent?: string) => Promise<void>;
  workspaceId: string;
  channelId?: string;
  dmId?: string;
  contextMemberIds?: string[];
  contextType?: 'channel' | 'dm';
  onTyping?: (typing: boolean) => void;
  onEdit: (message: Message, content: string, formattedContent?: string) => Promise<void>;
  onDelete: (message: Message) => Promise<void>;
  onReact: (message: Message, emoji: string, selected?: boolean) => Promise<void>;
  savedMessageIds?: Set<string>;
  canPin?: boolean;
  onSave?: (message: Message) => Promise<void>;
  onPin?: (message: Message, pinned: boolean) => Promise<void>;
  onForward: (message: Message) => void;
}

export default function ThreadPanel({ parent, replies, currentUserId, members, loading, error, typingText, onClose, onSend, workspaceId, channelId, dmId, contextMemberIds = [], contextType, onTyping, onEdit, onDelete, onReact, savedMessageIds, canPin = false, onSave, onPin, onForward }: Props) {
  const readContainer = useMessageReadReceipts(workspaceId);
  const [eventSavedIds, setEventSavedIds] = useState<Set<string>>(new Set());
  const [eventCanPin, setEventCanPin] = useState(false);
  const [eventFocusId, setEventFocusId] = useState<string | null>(null);
  const effectiveSavedIds = savedMessageIds || eventSavedIds;
  const effectiveCanPin = canPin || eventCanPin;
  const save = onSave || ((message: Message) => { window.dispatchEvent(new CustomEvent('unichat:save', { detail: message })); return Promise.resolve(); });
  const pin = onPin || ((message: Message, pinned: boolean) => { window.dispatchEvent(new CustomEvent('unichat:pin', { detail: { message, pinned } })); return Promise.resolve(); });
  useEffect(() => {
    const onState = (event: Event) => setEventSavedIds(new Set((event as CustomEvent<{ ids: string[] }>).detail.ids));
    const onChanged = (event: Event) => setEventSavedIds((current) => { const next = new Set(current); const { messageId, saved } = (event as CustomEvent<{ messageId: string; saved: boolean }>).detail; if (saved) next.add(messageId); else next.delete(messageId); return next; });
    const onCapability = (event: Event) => setEventCanPin(Boolean((event as CustomEvent<{ canPin: boolean }>).detail.canPin));
    const onFocus = (event: Event) => { const messageId = (event as CustomEvent<{ messageId: string }>).detail.messageId; setEventFocusId(messageId); window.setTimeout(() => setEventFocusId((current) => current === messageId ? null : current), 2800); };
    window.addEventListener('unichat:saved-state', onState); window.addEventListener('unichat:saved-changed', onChanged); window.addEventListener('unichat:pin-capable', onCapability); window.addEventListener('unichat:focus-message', onFocus);
    return () => { window.removeEventListener('unichat:saved-state', onState); window.removeEventListener('unichat:saved-changed', onChanged); window.removeEventListener('unichat:pin-capable', onCapability); window.removeEventListener('unichat:focus-message', onFocus); };
  }, []);
  useEffect(() => { if (eventFocusId) document.getElementById(`message-${eventFocusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [eventFocusId, replies.length]);
  return <aside className="thread-panel flex w-[380px] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--surface-main)]" aria-label="Thread panel">
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-4"><div><h2 className="text-lg font-semibold text-[var(--text-primary)]">Thread</h2><p className="text-xs text-[var(--text-secondary)]">{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</p></div><button type="button" onClick={onClose} className="text-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)]" aria-label="Close thread" title="Close thread">×</button></div>
    <div ref={readContainer} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div data-message-id={parent._id} className="border-b border-[var(--border-subtle)] pb-4"><div className="flex gap-2"><Avatar user={parent.sender} size="sm" /><div className="min-w-0"><div className="flex items-baseline gap-2"><span className="text-xs font-semibold text-[var(--text-primary)]">{parent.sender?.displayName || 'Unknown user'}</span><span className="text-[10px] text-[var(--text-muted)]">{new Date(parent.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div><div className="mt-1"><RichMessageContent message={parent} members={members} /></div><AttachmentDisplay attachments={parent.attachments} /></div></div></div>
      <div className="py-4"><p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</p>{loading && <p className="text-xs text-[var(--text-secondary)]">Loading thread…</p>}{!loading && !replies.length && <p className="text-xs text-[var(--text-secondary)]">Be the first to reply.</p>}<div className="space-y-1">{replies.map((message) => <MessageItem key={message._id} workspaceId={workspaceId} message={message} currentUserId={currentUserId} members={members} contextMemberIds={contextMemberIds} contextType={contextType} allowThread={false} onEdit={onEdit} onDelete={onDelete} onReact={onReact} onOpenThread={() => undefined} isSaved={effectiveSavedIds.has(message._id)} canPin={effectiveCanPin} onSave={save} onPin={pin} onForward={onForward} isFocused={message._id === eventFocusId} />)}</div>{error && <p className="mt-3 text-xs text-[var(--error)]" role="alert">{error}</p>}</div>
    </div>
    <MessageComposer placeholder="Reply to thread" typingText={typingText} members={members} contextMemberIds={contextMemberIds} contextType={contextType} workspaceId={workspaceId} channelId={channelId} dmId={dmId} parentMessageId={parent._id} onSend={onSend} onTyping={onTyping} />
  </aside>;
}
