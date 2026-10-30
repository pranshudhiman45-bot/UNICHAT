import { useMemo, useState } from 'react';
import type { Channel, DirectMessage, Message } from '../../types';
import Modal from '../common/Modal';
import { dmTitle } from '../layout/WorkspaceSidebar';

export type ForwardTarget = { type: 'channel'; id: string } | { type: 'dm'; id: string };

interface Props {
  message: Message;
  channels: Channel[];
  dms: DirectMessage[];
  currentUserId: string;
  onClose: () => void;
  onForward: (target: ForwardTarget) => Promise<void>;
}

export default function ForwardMessageModal({ message, channels, dms, currentUserId, onClose, onForward }: Props) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ForwardTarget | null>(null);
  const [forwarding, setForwarding] = useState(false);
  const [error, setError] = useState('');
  const destinations = useMemo(() => [
    ...channels.filter((channel) => channel.isMember).map((channel) => ({ type: 'channel' as const, id: channel._id, name: `${channel.type === 'private' ? '🔒' : '#'} ${channel.name}`, subtitle: 'Channel' })),
    ...dms.map((dm) => ({ type: 'dm' as const, id: dm._id, name: dmTitle(dm, currentUserId), subtitle: dm.isGroup ? 'Group message' : 'Direct message' })),
  ].filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase())), [channels, dms, currentUserId, query]);

  const submit = async () => {
    if (!selected) return;
    setForwarding(true);
    setError('');
    try { await onForward(selected); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to forward this message'); }
    finally { setForwarding(false); }
  };

  return <Modal title="Forward message" onClose={forwarding ? () => undefined : onClose}>
    <div className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--bg-surface-secondary)] p-3">
      <p className="line-clamp-3 break-words text-xs leading-5 text-[var(--text-secondary)]">{message.content || (message.attachments?.length ? `${message.attachments.length} attachment${message.attachments.length === 1 ? '' : 's'}` : 'Message')}</p>
      {message.attachments?.length ? <p className="mt-2 text-[10px] text-[var(--text-muted)]">Attachments will be forwarded with the message.</p> : null}
    </div>
    <label htmlFor="forward-destination" className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">Send to</label>
    <input id="forward-destination" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a channel or person" className="mb-2 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]" />
    <div className="max-h-56 overflow-y-auto rounded-md border border-[var(--border)]" role="group" aria-label="Forward destinations">
      {!destinations.length && <p className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">No accessible destinations found.</p>}
      {destinations.map((destination) => {
        const active = selected?.type === destination.type && selected.id === destination.id;
        return <button key={`${destination.type}:${destination.id}`} type="button" aria-pressed={active} onClick={() => { setSelected({ type: destination.type, id: destination.id }); setError(''); }} className={`flex w-full items-center gap-3 border-b border-[var(--border)] px-3 py-2.5 text-left last:border-0 ${active ? 'bg-[var(--bg-surface-secondary)]' : 'hover:bg-[var(--bg-surface-secondary)]'}`}>
          <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--surface)] text-xs text-[var(--text-muted)]">{destination.type === 'channel' ? '#' : '↗'}</span>
          <span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold text-[var(--text)]">{destination.name}</span><span className="text-[10px] text-[var(--text-muted)]">{destination.subtitle}</span></span>
          {active && <span aria-hidden="true" className="text-xs font-semibold text-[var(--accent)]">✓</span>}
        </button>;
      })}
    </div>
    <p className="mt-2 text-[10px] leading-4 text-[var(--text-muted)]">The forwarded copy includes the original sender and conversation. People in the destination can see the copied content and attachments.</p>
    {error && <p className="mt-3 text-xs text-[var(--error)]" role="alert">{error}</p>}
    <div className="mt-4 flex justify-end gap-2"><button type="button" disabled={forwarding} onClick={onClose} className="rounded-md border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-surface-secondary)]">Cancel</button><button type="button" disabled={!selected || forwarding} onClick={() => void submit()} className="rounded-md bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50">{forwarding ? 'Forwarding…' : 'Forward'}</button></div>
  </Modal>;
}
