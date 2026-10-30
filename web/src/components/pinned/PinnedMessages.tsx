import type { PinnedMessage, User } from '../../types';
import Avatar from '../common/Avatar';
import Modal from '../common/Modal';
import RichMessageContent from '../messages/RichMessageContent';
import { getUserDisplayName } from '../../utils/userDisplay';

interface Props {
  items: PinnedMessage[];
  onClose: () => void;
  onOpen: (item: PinnedMessage) => void;
  members: User[];
  error?: string;
  onRetry?: () => void;
}

export default function PinnedMessages({ items, onClose, onOpen, members, error, onRetry }: Props) {
  return <Modal title="Pinned messages" onClose={onClose}><div className="max-h-[65vh] overflow-y-auto">{error && <p className="py-5 text-center text-xs text-[var(--error)]" role="alert">{error} {onRetry && <button type="button" onClick={onRetry} className="font-semibold underline">Retry</button>}</p>}{!error && !items.length && <p className="py-10 text-center text-xs text-[var(--text-muted)]">No pinned messages in this channel.</p>}{!error && items.map((item) => <button key={item.message._id} type="button" onClick={() => onOpen(item)} className="ui-interactive-row flex w-full gap-3 border-b border-[var(--border)] px-1 py-3 text-left last:border-0"><Avatar user={item.message.sender} size="sm" /><span className="min-w-0 flex-1"><span className="block text-[11px] font-semibold text-[var(--text)]">{getUserDisplayName(item.message.sender)}</span><span className="mt-1 block break-words text-xs leading-5 text-[var(--text-secondary)]">{item.message.content ? <RichMessageContent message={item.message} members={members} /> : 'Attachment'}</span><span className="mt-1 block text-[10px] text-[var(--text-muted)]">Pinned by {item.pinnedBy ? getUserDisplayName(item.pinnedBy) : 'channel admin'} · {new Date(item.pinnedAt).toLocaleString()}</span></span></button>)}</div></Modal>;
}
