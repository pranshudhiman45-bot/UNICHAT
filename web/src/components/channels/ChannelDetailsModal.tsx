import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Modal from '../common/Modal';
import Avatar from '../common/Avatar';
import { api } from '../../hooks/useAuth';
import type { Channel, User } from '../../types';
import { getUserDisplayName } from '../../utils/userDisplay';

interface Props {
  channelId: string;
  workspaceMembers: User[];
  currentUserId: string;
  onClose: () => void;
  onLeft: () => void;
  onChanged: () => void;
}
type DetailedChannel = Omit<Channel, 'members'> & { topic?: string; isArchived?: boolean; isDefault?: boolean; canManage?: boolean; myRole?: string | null; members: Array<{ user: User; role: string }> };

const field = 'mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none';

export default function ChannelDetailsModal({ channelId, workspaceMembers, currentUserId, onClose, onLeft, onChanged }: Props) {
  const [channel, setChannel] = useState<DetailedChannel | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(''); const [topic, setTopic] = useState(''); const [description, setDescription] = useState('');
  const [invitees, setInvitees] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<'leave' | 'archive' | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/channels/' + channelId);
      const detailed = data.channel as DetailedChannel;
      detailed.members = (detailed.members || []).filter((member) => member.user && typeof member.user === 'object');
      setChannel(detailed); setName(detailed.name); setTopic(detailed.topic || ''); setDescription(detailed.description || '');
    } catch (err: any) { setError(err.response?.data?.error || 'Unable to load channel details'); }
  }, [channelId]);
  useEffect(() => { void load(); }, [load]);

  const run = async (action: () => Promise<unknown>, after?: () => void) => {
    setBusy(true); setError('');
    try { await action(); await load(); onChanged(); after?.(); }
    catch (err: any) { setError(err.response?.data?.error || 'That did not work. Please try again.'); setConfirm(null); }
    finally { setBusy(false); }
  };

  if (!channel) return <Modal title="Channel details" onClose={onClose}>{error ? <p role="alert" className="text-sm text-[var(--error)]">{error}</p> : <p className="text-sm text-[var(--text-secondary)]">Loading…</p>}</Modal>;
  const canManage = Boolean(channel.canManage);
  const memberIds = new Set(channel.members.map((member) => member.user._id));
  const addable = workspaceMembers.filter((member) => !memberIds.has(member._id));
  const adminCount = channel.members.filter((member) => member.role === 'admin').length;
  const save = (event: FormEvent) => { event.preventDefault(); void run(() => api.patch('/channels/' + channelId, { name, topic, description })); };

  return <Modal title={`${channel.type === 'private' ? '🔒' : '#'} ${channel.name}`} onClose={onClose}>
    <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
      {error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      {channel.isArchived && <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">This channel is archived. It is read-only.</p>}

      {canManage ? <form onSubmit={save} className="space-y-3">
        <label className="block text-xs font-medium text-[var(--text-secondary)]">Name<input className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={channel.isDefault} /></label>
        <label className="block text-xs font-medium text-[var(--text-secondary)]">Topic<input className={field} value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={250} /></label>
        <label className="block text-xs font-medium text-[var(--text-secondary)]">Description<textarea className={field} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></label>
        <button type="submit" disabled={busy} className="ui-primary-button px-3 py-1.5 text-xs">Save changes</button>
      </form> : <div className="space-y-1 text-sm">{channel.topic && <p><span className="text-[var(--text-muted)]">Topic: </span>{channel.topic}</p>}{channel.description && <p className="text-[var(--text-secondary)]">{channel.description}</p>}</div>}

      <section aria-label="Members">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{channel.members.length} member{channel.members.length === 1 ? '' : 's'}</h3>
        <ul className="space-y-1">{channel.members.map((member) => {
          const isMe = member.user._id === currentUserId;
          return <li key={member.user._id} className="flex items-center gap-2 text-sm">
            <Avatar user={member.user} size="sm" /><span className="min-w-0 flex-1 truncate">{getUserDisplayName(member.user)}{isMe ? ' (you)' : ''}</span>
            {member.role === 'admin' && <span className="rounded bg-[var(--primary-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--accent)]">Admin</span>}
            {canManage && !isMe && !channel.isArchived && <>
              <button type="button" disabled={busy || (member.role === 'admin' && adminCount <= 1)} className="text-[11px] text-[var(--accent)] hover:underline disabled:opacity-40" onClick={() => void run(() => api.put(`/channels/${channelId}/members/${member.user._id}/role`, { role: member.role === 'admin' ? 'member' : 'admin' }))}>{member.role === 'admin' ? 'Remove admin' : 'Make admin'}</button>
              {!channel.isDefault && <button type="button" disabled={busy || (member.role === 'admin' && adminCount <= 1)} className="text-[11px] text-[var(--error)] hover:underline disabled:opacity-40" onClick={() => void run(() => api.delete(`/channels/${channelId}/members/${member.user._id}`))}>Remove</button>}
            </>}
          </li>;
        })}</ul>
      </section>

      {canManage && !channel.isArchived && addable.length > 0 && <section aria-label="Add people">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Add people</h3>
        <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-[var(--border)] p-2">{addable.map((member) => <label key={member._id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={invitees.includes(member._id)} onChange={(e) => setInvitees((current) => e.target.checked ? [...current, member._id] : current.filter((id) => id !== member._id))} />{getUserDisplayName(member)}</label>)}</div>
        <button type="button" disabled={busy || !invitees.length} className="ui-secondary-button mt-2 px-3 py-1.5 text-xs" onClick={() => void run(() => api.post(`/channels/${channelId}/invite`, { userIds: invitees }), () => setInvitees([]))}>Add {invitees.length || ''} selected</button>
      </section>}

      <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
        {!channel.isDefault && memberIds.has(currentUserId) && (confirm === 'leave'
          ? <><span className="self-center text-xs">Leave this channel?</span><button type="button" disabled={busy} className="ui-primary-button px-3 py-1.5 text-xs" onClick={() => void run(() => api.post(`/channels/${channelId}/leave`), onLeft)}>Yes, leave</button><button type="button" className="ui-secondary-button px-3 py-1.5 text-xs" onClick={() => setConfirm(null)}>Cancel</button></>
          : <button type="button" className="ui-secondary-button px-3 py-1.5 text-xs" onClick={() => setConfirm('leave')}>Leave channel</button>)}
        {canManage && !channel.isDefault && (channel.isArchived
          ? <button type="button" disabled={busy} className="ui-secondary-button px-3 py-1.5 text-xs" onClick={() => void run(() => api.patch('/channels/' + channelId, { isArchived: false }))}>Restore channel</button>
          : confirm === 'archive'
            ? <><span className="self-center text-xs">Archive for everyone?</span><button type="button" disabled={busy} className="ui-primary-button px-3 py-1.5 text-xs" onClick={() => void run(() => api.delete('/channels/' + channelId), onLeft)}>Yes, archive</button><button type="button" className="ui-secondary-button px-3 py-1.5 text-xs" onClick={() => setConfirm(null)}>Cancel</button></>
            : <button type="button" className="ui-secondary-button px-3 py-1.5 text-xs text-[var(--error)]" onClick={() => setConfirm('archive')}>Archive channel</button>)}
      </div>
    </div>
  </Modal>;
}
