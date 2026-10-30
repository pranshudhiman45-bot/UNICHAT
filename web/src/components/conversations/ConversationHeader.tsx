import type { ReactNode } from 'react';
import type { Channel, DirectMessage, User } from '../../types';
import Avatar from '../common/Avatar';
import UiIcon from '../common/UiIcon';
import { dmTitle } from '../layout/WorkspaceSidebar';

export type ConversationView = 'messages' | 'files';

interface Props {
  type: 'channel' | 'dm';
  channel?: Channel | null;
  dm?: DirectMessage | null;
  currentUser: User;
  view: ConversationView;
  onViewChange: (view: ConversationView) => void;
  onOpenPins?: () => void;
  onOpenDetails?: () => void;
}

function ViewTab({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`-mb-px inline-flex items-center gap-2 border-b-2 px-2.5 py-2.5 text-xs font-semibold transition-colors ${active ? 'border-[var(--accent)] text-[var(--text)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}`}>
    {children}
  </button>;
}

export default function ConversationHeader({ type, channel, dm, currentUser, view, onViewChange, onOpenPins, onOpenDetails }: Props) {
  if (type === 'channel' && channel) {
    return <header className="conversation-header shrink-0 border-b border-[var(--header-border)] bg-[var(--header-bg)] px-6 pt-3">
      <div className="flex min-h-8 items-center gap-2">
        <span className="text-[var(--text-muted)]"><UiIcon name={channel.type === 'private' ? 'lock' : 'hash'} size={16} /></span>
        <h1 className="conversation-title min-w-0 truncate tracking-tight text-[var(--text)]">{channel.name}</h1>
        {channel.description && <span className="ml-2 hidden truncate border-l border-[var(--border)] pl-3 text-xs text-[var(--text-muted)] md:block">{channel.description}</span>}
        {onOpenDetails && <button type="button" onClick={onOpenDetails} className="ml-auto rounded-md px-2 py-1 text-xs font-semibold text-[var(--text-muted)] hover:bg-[var(--bg-surface-secondary)] hover:text-[var(--text)]" aria-label="Channel details and members">Details</button>}
      </div>
      <nav className="mt-1 flex items-center gap-1" aria-label={`${channel.name} conversation shortcuts`}>
        <ViewTab active={view === 'messages'} onClick={() => onViewChange('messages')}><UiIcon name="activity" size={14} />Messages</ViewTab>
        <ViewTab active={view === 'files'} onClick={() => onViewChange('files')}><UiIcon name="file" size={14} />Files &amp; links</ViewTab>
        <button type="button" onClick={() => onOpenPins ? onOpenPins() : window.dispatchEvent(new CustomEvent('unichat:pins-open'))} className="-mb-px inline-flex items-center gap-2 border-b-2 border-transparent px-2.5 py-2.5 text-xs font-semibold text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]" aria-label="View pinned messages">
          <UiIcon name="pin" size={14} />Pins
        </button>
      </nav>
    </header>;
  }

  if (!dm) return null;
  const participant = dm.participants.find((user) => user._id !== currentUser._id);
  return <header className="conversation-header shrink-0 border-b border-[var(--header-border)] bg-[var(--header-bg)] px-6 pt-3">
    <div className="flex min-h-8 items-center gap-3">
      {dm.isGroup ? <div className="flex -space-x-2">{dm.participants.slice(0, 3).map((user) => <Avatar key={user._id} user={user} size="sm" />)}</div> : <Avatar user={participant} size="sm" showPresence />}
      <div className="min-w-0"><h1 className="conversation-title truncate tracking-tight text-[var(--text)]">{dmTitle(dm, currentUser._id)}</h1><p className="text-xs text-[var(--text-secondary)]">{dm.isGroup ? `${dm.participants.length} members` : participant?.title || participant?.status || 'Direct message'}</p></div>
      {dm.isGroup && onOpenDetails && <button type="button" onClick={onOpenDetails} className="ml-auto rounded-md px-2 py-1 text-xs font-semibold text-[var(--text-muted)] hover:bg-[var(--bg-surface-secondary)] hover:text-[var(--text)]" aria-label="Group details and members">Details</button>}
    </div>
    <nav className="mt-1 flex items-center gap-1" aria-label="Direct message shortcuts">
      <ViewTab active={view === 'messages'} onClick={() => onViewChange('messages')}><UiIcon name="activity" size={14} />Messages</ViewTab>
      <ViewTab active={view === 'files'} onClick={() => onViewChange('files')}><UiIcon name="file" size={14} />Files &amp; links</ViewTab>
    </nav>
  </header>;
}
