import type { SavedMessage, User } from '../../types';
import Avatar from '../common/Avatar';
import Modal from '../common/Modal';
import RichMessageContent from '../messages/RichMessageContent';
import { getUserDisplayName } from '../../utils/userDisplay';

interface Props {
  items: SavedMessage[];
  onClose: () => void;
  onOpen: (item: SavedMessage) => void;
  onUnsave: (item: SavedMessage) => void;
  members: User[];
  error?: string;
  onRetry?: () => void;
}

export default function SavedMessages({ items, onClose, onOpen, onUnsave, members, error, onRetry }: Props) {
  return <Modal title="Saved for later" onClose={onClose}><div className="max-h-[65vh] overflow-y-auto">{error && <p className="py-5 text-center text-xs text-[var(--error)]" role="alert">{error} {onRetry && <button type="button" onClick={onRetry} className="font-semibold underline">Retry</button>}</p>}{!error && !items.length && <p className="py-10 text-center text-xs text-[var(--text-muted)]">No saved messages yet.</p>}{!error && items.map((item) => <div key={item._id} className="border-b border-[var(--border)] px-1 py-3 last:border-0"><button type="button" onClick={() => onOpen(item)} className="ui-interactive-row flex w-full gap-3 rounded-md p-1 text-left"><Avatar user={item.message.sender} size="sm" /><span className="min-w-0 flex-1"><span className="flex items-center gap-2 text-[11px]"><strong className="text-[var(--text)]">{getUserDisplayName(item.message.sender)}</strong><span className="text-[var(--text-muted)]">{item.channel ? `#${item.channel.name}` : 'Direct message'}</span><span className="text-[var(--text-muted)]">{new Date(item.message.createdAt).toLocaleString()}</span></span><span className="mt-1 block break-words text-xs leading-5 text-[var(--text-secondary)]">{item.message.content ? <RichMessageContent message={item.message} members={members} /> : 'Attachment'}</span>{item.message.attachments?.length ? <span className="mt-1 block text-[10px] text-[var(--text-muted)]">📎 {item.message.attachments.length} attachment(s)</span> : null}</span></button><div className="mt-2 flex justify-end"><button type="button" onClick={() => onUnsave(item)} className="text-[10px] font-semibold text-[var(--text-muted)] hover:text-[var(--accent)]">Remove saved message</button></div></div>)}</div></Modal>;
}
