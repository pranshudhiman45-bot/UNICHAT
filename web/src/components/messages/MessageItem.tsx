import { useState } from 'react';
import type { Message, User } from '../../types';
import Avatar from '../common/Avatar';
import Modal from '../common/Modal';
import RichMessageContent from './RichMessageContent';
import UserProfilePopover from '../users/UserProfilePopover';
import MessageActionToolbar from './MessageActionToolbar';
import MessageEditForm from './MessageEditForm';
import ReactionBar from './ReactionBar';
import AttachmentDisplay from './AttachmentDisplay';
import { getDisplayText, getUserDisplayName } from '../../utils/userDisplay';
import { messageLink } from '../../utils/messageLink';

interface Props {
  workspaceId: string;
  message: Message;
  grouped?: boolean;
  currentUserId: string;
  members: User[];
  onEdit: (message: Message, content: string, formattedContent?: string) => Promise<void>;
  onDelete: (message: Message) => Promise<void>;
  onReact: (message: Message, emoji: string, selected?: boolean) => Promise<void>;
  onOpenThread?: (message: Message) => void;
  allowThread?: boolean;
  threadUnread?: boolean;
  onMessageUser?: (user: Message['sender']) => void;
  isSaved?: boolean;
  canPin?: boolean;
  onSave: (message: Message) => Promise<void>;
  onPin: (message: Message, pinned: boolean) => Promise<void>;
  onForward: (message: Message) => void;
  isFocused?: boolean;
  contextMemberIds?: string[];
  contextType?: 'channel' | 'dm';
}

export default function MessageItem({ workspaceId, message, grouped = false, currentUserId, members, onEdit, onDelete, onReact, onOpenThread, allowThread = true, threadUnread = false, onMessageUser, isSaved = false, canPin = false, onSave, onPin, onForward, isFocused = false, contextMemberIds = [], contextType }: Props) {
  const [profileOpen, setProfileOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const mentionedCurrentUser = message.mentions?.some((id) => String(id) === currentUserId);
  const canEdit = message.sender?._id === currentUserId && !message.isSystemMessage;
  const canDelete = canEdit;
  const openProfile = () => setProfileOpen((open) => !open);
  const forwardedSender = message.forwardedFrom?.senderName?.trim();
  const forwardedConversation = message.forwardedFrom?.conversationName?.trim();
  const hasForwardAttribution = Boolean(forwardedSender || forwardedConversation);
  const link = messageLink(message, workspaceId, window.location.origin);

  return <article data-message-id={message._id} id={`message-${message._id}`} aria-label={grouped ? `Message from ${getUserDisplayName(message.sender)} at ${new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : undefined} className={`chat-message group relative flex gap-3 ${grouped ? 'chat-message-grouped' : ''} ${message.isSystemMessage ? 'opacity-60' : ''} ${mentionedCurrentUser ? 'chat-message-mention border-l-2 border-[var(--accent)]' : ''} ${isFocused ? 'activity-message-highlight' : ''}`}>
    <div className="relative"><button type="button" aria-label={`View ${getUserDisplayName(message.sender)} profile`} onClick={openProfile} className={grouped ? 'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100' : undefined}><Avatar user={message.sender} size="md" /></button>{profileOpen && <UserProfilePopover user={message.sender} onClose={() => setProfileOpen(false)} onMessage={() => { setProfileOpen(false); onMessageUser?.(message.sender); }} />}</div>
    <div className="min-w-0 flex-1">
      {!grouped && <div className="flex items-baseline gap-2"><button type="button" onClick={openProfile} className="text-sm font-semibold text-[var(--text-primary)] hover:text-[var(--accent)]">{getUserDisplayName(message.sender)}</button><span className="text-xs font-normal text-[var(--text-secondary)]">{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>{message.isEdited && <span className="text-xs text-[var(--text-secondary)]">(edited)</span>}</div>}
      {grouped && message.isEdited && <span className="text-[11px] text-[var(--text-secondary)]">(edited)</span>}
      {hasForwardAttribution && <div className="mb-1 flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]"><span aria-hidden="true">↪</span><span>{forwardedSender ? <>Forwarded from <strong className="font-semibold text-[var(--text-secondary)]">{forwardedSender}</strong></> : 'Forwarded message'}{forwardedConversation ? <> in <strong className="font-semibold text-[var(--text-secondary)]">{forwardedConversation}</strong></> : null}{message.forwardedFrom?.isThreadReply ? ' · thread' : ''}</span></div>}
      {editing ? <MessageEditForm initialValue={message.content} initialFormattedContent={message.formattedContent} members={members} contextMemberIds={contextMemberIds} contextType={contextType} saving={savingEdit} error={editError} onCancel={() => { setEditing(false); setEditError(''); }} onSave={async (content, formattedContent) => { setSavingEdit(true); setEditError(''); try { await onEdit(message, content, formattedContent); setEditing(false); } catch (error) { setEditError(error instanceof Error ? error.message : 'Unable to save message'); } finally { setSavingEdit(false); } }} /> : <div className="relative pr-2"><RichMessageContent message={message} members={members} />{!message.isSystemMessage && <div className="invisible absolute -right-1 top-0 group-hover:visible group-focus-within:visible"><MessageActionToolbar currentUserId={currentUserId} reactions={message.reactions} canEdit={canEdit} canDelete={canDelete} allowThread={allowThread} isSaved={isSaved} canPin={canPin} isPinned={message.isPinned} onReact={(emoji, selected) => void onReact(message, emoji, selected)} onReply={() => onOpenThread?.(message)} onSave={() => void onSave(message)} onPin={() => void onPin(message, Boolean(message.isPinned))} onForward={() => onForward(message)} onCopyText={message.content.trim() ? () => navigator.clipboard.writeText(getDisplayText(message.content, members)) : undefined} onCopyLink={link ? () => navigator.clipboard.writeText(link) : undefined} onEdit={() => { setEditing(true); setEditError(''); }} onDelete={() => { setDeleteOpen(true); setDeleteError(''); }} /></div>}</div>}
      <AttachmentDisplay attachments={message.attachments} />
      <ReactionBar reactions={message.reactions} currentUserId={currentUserId} onToggle={(emoji, selected) => void onReact(message, emoji, selected)} />
      {allowThread && (message.thread?.replyCount || 0) > 0 && <button type="button" onClick={() => onOpenThread?.(message)} className="mt-1 text-[11px] font-medium text-[var(--accent)] hover:underline">{message.thread?.replyCount} {(message.thread?.replyCount || 0) === 1 ? 'reply' : 'replies'}{threadUnread && <span className="ml-2 rounded bg-[var(--error)] px-1.5 py-0.5 text-[10px] text-white">New</span>}{message.thread?.lastReplyAt ? ` · ${new Date(message.thread.lastReplyAt).toLocaleDateString()}` : ''}</button>}
    </div>
    {deleteOpen && <Modal title="Delete message?" onClose={() => { if (!deleting) setDeleteOpen(false); }}><p className="text-sm text-slate-600">This cannot be undone.</p>{deleteError && <p className="mt-3 text-xs text-[var(--error)]" role="alert">{deleteError}</p>}<div className="mt-5 flex justify-end gap-2"><button type="button" disabled={deleting} onClick={() => setDeleteOpen(false)} className="border border-slate-200 px-4 py-2 text-xs text-slate-600">Cancel</button><button type="button" disabled={deleting} onClick={async () => { setDeleting(true); setDeleteError(''); try { await onDelete(message); setDeleteOpen(false); } catch (error) { setDeleteError(error instanceof Error ? error.message : 'Unable to delete message'); } finally { setDeleting(false); } }} className="bg-[var(--error)] px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">{deleting ? 'Deleting…' : 'Delete'}</button></div></Modal>}
  </article>;
}
