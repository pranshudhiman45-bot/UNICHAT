import type { User } from '../../types';
import Avatar from '../common/Avatar';

export default function UserProfilePopover({ user, onMessage, onClose }: { user: User; onMessage: () => void; onClose: () => void }) {
  return <div className="app-card absolute left-0 top-10 z-20 w-60 rounded-[10px] border border-[var(--border)] bg-[var(--popup-bg)] p-4 text-left" onClick={(event) => event.stopPropagation()}><div className="flex items-center gap-3"><Avatar user={user} size="lg" showPresence /><div className="min-w-0"><p className="truncate text-sm font-semibold text-[var(--text-primary)]">{user.displayName}</p><p className="truncate text-xs text-[var(--text-secondary)]">@{user.username}</p></div></div><p className="mt-3 text-xs text-[var(--text-secondary)]">{user.title || 'Unichat member'}</p><p className="mt-1 text-xs text-[var(--text-secondary)]">{user.status === 'online' ? 'Online' : user.status || 'Offline'}</p><div className="mt-4 flex gap-2"><button onClick={onMessage} className="ui-primary-button px-3 py-1.5 text-sm font-semibold">Message</button><button onClick={onClose} className="ui-secondary-button px-3 py-1.5 text-sm font-semibold">Close</button></div></div>;
}
