import { useRef, useState, type ReactNode, type Ref } from 'react';
import type { Reaction } from '../../types';
import ReactionPicker from './ReactionPicker';
import FloatingMenu from '../common/FloatingMenu';

const quickReactions = ['\u2705', '\u{1F440}', '\u{1F64C}'];
type IconName = 'reaction' | 'thread' | 'bookmark' | 'pin' | 'forward' | 'more' | 'link' | 'copy' | 'edit' | 'delete';

interface Props {
  canEdit: boolean;
  canDelete: boolean;
  currentUserId?: string;
  reactions?: Reaction[];
  onReact: (emoji: string, selected?: boolean) => void;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopyText?: () => Promise<void>;
  onCopyLink?: () => Promise<void>;
  allowThread?: boolean;
  isSaved?: boolean;
  canPin?: boolean;
  isPinned?: boolean;
  onSave: () => void;
  onPin: () => void;
  onForward: () => void;
}

function ToolbarIcon({ name }: { name: IconName }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return <svg aria-hidden="true" viewBox="0 0 20 20" className="h-[17px] w-[17px]" {...common}>
    {name === 'reaction' && <><circle cx="8.5" cy="9" r="5.6" /><path d="M6.5 10.5c.6.8 1.3 1.2 2 1.2s1.4-.4 2-1.2M6.7 7.7h.1m3.4 0h.1M15.5 12v5m-2.5-2.5h5" /></>}
    {name === 'thread' && <><path d="M3.2 4.5h13.6v9H9l-4.5 3v-3H3.2z" /><path d="M6.3 7.5h7.4m-7.4 3h5.1" /></>}
    {name === 'bookmark' && <path d="M5 3.5h10v13l-5-3.2-5 3.2z" />}
    {name === 'pin' && <><path d="m7 3.5 6 6m-8-4 8 8m-6-6-4 4h8l4-4m-5 5-1 5" /></>}
    {name === 'forward' && <path d="M11 4.5 16.5 10 11 15.5v-3.2H8.5a4 4 0 0 0-4 4v-.8a6 6 0 0 1 6-6H11z" />}
    {name === 'more' && <><circle cx="4" cy="10" r=".8" fill="currentColor" stroke="none" /><circle cx="10" cy="10" r=".8" fill="currentColor" stroke="none" /><circle cx="16" cy="10" r=".8" fill="currentColor" stroke="none" /></>}
    {name === 'link' && <><path d="m8 12 4-4M7.3 6.2l1.4-1.4a3.2 3.2 0 0 1 4.5 4.5l-1.4 1.4m-3.6-1.4-1.4 1.4a3.2 3.2 0 0 0 4.5 4.5l1.4-1.4" /></>}
    {name === 'copy' && <><rect x="6" y="6" width="10" height="10" rx="1.5" /><path d="M12 6V4.5A1.5 1.5 0 0 0 10.5 3h-6A1.5 1.5 0 0 0 3 4.5v6A1.5 1.5 0 0 0 4.5 12H6" /></>}
    {name === 'edit' && <><path d="m4 13.5-.6 3.1 3.1-.6L16 6.5 13.5 4 4 13.5zM12 5.5l2.5 2.5" /></>}
    {name === 'delete' && <><path d="M4.5 6h11m-9.5 0 .7 10h6.6l.7-10M8 6V4h4v2m-3.5 3v4.5m3-4.5v4.5" /></>}
  </svg>;
}

function ToolbarButton({ label, title, onClick, active = false, danger = false, buttonRef, expanded, children }: { label: string; title: string; onClick?: () => void; active?: boolean; danger?: boolean; buttonRef?: Ref<HTMLButtonElement>; expanded?: boolean; children: ReactNode }) {
  return <button ref={buttonRef} type="button" onClick={onClick} className={`message-action-button ${active ? 'message-action-button-active' : ''} ${danger ? 'message-action-button-danger' : ''}`} aria-label={label} aria-expanded={expanded} title={title}>{children}</button>;
}

function MenuAction({ icon, label, onClick, danger = false }: { icon: IconName; label: string; onClick: () => void; danger?: boolean }) {
  return <button type="button" role="menuitem" onClick={onClick} className={danger ? 'message-action-more-danger' : undefined}>
    <span className="message-action-more-icon"><ToolbarIcon name={icon} /></span><span>{label}</span>
  </button>;
}

export default function MessageActionToolbar({ canEdit, canDelete, currentUserId, reactions = [], onReact, onReply, onEdit, onDelete, onCopyText, onCopyLink, allowThread = true, isSaved = false, canPin = false, isPinned = false, onSave, onPin, onForward }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const reactionButtonRef = useRef<HTMLButtonElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const isSelected = (emoji: string) => Boolean(reactions.find((reaction) => reaction.emoji === emoji)?.users.some((userId) => String(userId) === String(currentUserId)));
  const react = (emoji: string) => onReact(emoji, isSelected(emoji));
  const closeMore = () => setMoreOpen(false);
  const copy = async (action: () => Promise<void>, label: string) => {
    try { await action(); setCopyStatus(`${label} copied`); closeMore(); }
    catch { setCopyStatus('Clipboard unavailable. Check browser permissions.'); }
  };

  return <div className="message-action-toolbar" role="toolbar" aria-label="Message actions">
    {quickReactions.map((emoji) => <ToolbarButton key={emoji} label={`React with ${emoji}`} title={`React with ${emoji}`} active={isSelected(emoji)} onClick={() => react(emoji)}>{emoji}</ToolbarButton>)}
    <span className="message-action-divider" aria-hidden="true" />
    <div className="message-action-menu-anchor"><ToolbarButton buttonRef={reactionButtonRef} label="Add reaction" title="Add reaction" onClick={() => setPickerOpen((open) => { if (!open) setMoreOpen(false); return !open; })}><ToolbarIcon name="reaction" /></ToolbarButton>{pickerOpen && <ReactionPicker anchorRef={reactionButtonRef} onSelect={(emoji) => { react(emoji); setPickerOpen(false); }} onClose={() => setPickerOpen(false)} />}</div>
    {allowThread && <ToolbarButton label="Reply in thread" title="Reply in thread" onClick={onReply}><ToolbarIcon name="thread" /></ToolbarButton>}
    <ToolbarButton label={isSaved ? 'Remove from saved' : 'Save for later'} title={isSaved ? 'Remove from saved' : 'Save for later'} active={isSaved} onClick={onSave}><ToolbarIcon name="bookmark" /></ToolbarButton>
    {canPin && <ToolbarButton label={isPinned ? 'Unpin message' : 'Pin message'} title={isPinned ? 'Unpin message' : 'Pin message'} active={isPinned} onClick={onPin}><ToolbarIcon name="pin" /></ToolbarButton>}
    <ToolbarButton label="Forward message" title="Forward message" onClick={onForward}><ToolbarIcon name="forward" /></ToolbarButton>
    <div className="message-action-menu-anchor">
      <ToolbarButton buttonRef={moreButtonRef} label="More actions" title="More actions" active={moreOpen} expanded={moreOpen} onClick={() => { setPickerOpen(false); setCopyStatus(''); setMoreOpen((open) => !open); }}><ToolbarIcon name="more" /></ToolbarButton>
      <FloatingMenu anchorRef={moreButtonRef} open={moreOpen} onClose={closeMore} placement="bottom" className="message-action-more" fallbackWidth={225} fallbackHeight={260} ariaLabel="More message actions">
        {onCopyLink && <MenuAction icon="link" label="Copy link" onClick={() => void copy(onCopyLink, 'Link')} />}
        {onCopyText && <MenuAction icon="copy" label="Copy message" onClick={() => void copy(onCopyText, 'Message')} />}
        {copyStatus && <p className="message-action-more-status" role="status">{copyStatus}</p>}
        <div className="message-action-more-separator" aria-hidden="true" />
        <MenuAction icon="bookmark" label={isSaved ? 'Remove from saved' : 'Save for later'} onClick={() => { closeMore(); onSave(); }} />
        {canPin && <MenuAction icon="pin" label={isPinned ? 'Unpin from channel' : 'Pin to channel'} onClick={() => { closeMore(); onPin(); }} />}
        <MenuAction icon="forward" label="Forward message" onClick={() => { closeMore(); onForward(); }} />
        {(canEdit || canDelete) && <div className="message-action-more-separator" aria-hidden="true" />}
        {canEdit && <MenuAction icon="edit" label="Edit message" onClick={() => { closeMore(); onEdit(); }} />}
        {canDelete && <MenuAction icon="delete" label="Delete message" danger onClick={() => { closeMore(); onDelete(); }} />}
      </FloatingMenu>
    </div>
    <span className="sr-only" role="status" aria-live="polite">{moreOpen ? '' : copyStatus}</span>
  </div>;
}
