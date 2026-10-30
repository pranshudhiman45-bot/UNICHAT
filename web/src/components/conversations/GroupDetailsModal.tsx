import { useState, type FormEvent } from 'react';
import Modal from '../common/Modal';
import Avatar from '../common/Avatar';
import { api } from '../../hooks/useAuth';
import type { DirectMessage, User } from '../../types';
import { getUserDisplayName } from '../../utils/userDisplay';

const field = 'mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none';

export default function GroupDetailsModal({ dm, workspaceMembers, currentUserId, onClose, onLeft }: { dm: DirectMessage; workspaceMembers: User[]; currentUserId: string; onClose: () => void; onLeft: () => void }) {
  const [name, setName] = useState(dm.groupName || '');
  const [invitees, setInvitees] = useState<string[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [confirmLeave, setConfirmLeave] = useState(false);
  const inGroup = new Set(dm.participants.map((p) => p._id));
  const addable = workspaceMembers.filter((member) => !inGroup.has(member._id));
  const run = async (action: () => Promise<unknown>, after?: () => void) => {
    setBusy(true); setError('');
    try { await action(); after?.(); } catch (err: any) { setError(err.response?.data?.error || 'That did not work. Please try again.'); setConfirmLeave(false); } finally { setBusy(false); }
  };
  const rename = (event: FormEvent) => { event.preventDefault(); void run(() => api.patch('/dms/' + dm._id, { groupName: name })); };
  return <Modal title="Group details" onClose={onClose}>
    <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
      {error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      <form onSubmit={rename} className="space-y-2"><label className="block text-xs font-medium text-[var(--text-secondary)]">Group name<input className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label><button type="submit" disabled={busy || !name.trim()} className="ui-primary-button px-3 py-1.5 text-xs">Rename</button></form>
      <section><h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{dm.participants.length} people</h3>
        <ul className="space-y-1">{dm.participants.map((p) => <li key={p._id} className="flex items-center gap-2 text-sm"><Avatar user={p} size="sm" /><span className="flex-1 truncate">{getUserDisplayName(p)}{p._id === currentUserId ? ' (you)' : ''}</span></li>)}</ul></section>
      {addable.length > 0 && <section><h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Add people</h3>
        <p className="mb-1 text-[11px] text-[var(--text-muted)]">New people can read the earlier messages in this group.</p>
        <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-[var(--border)] p-2">{addable.map((m) => <label key={m._id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={invitees.includes(m._id)} onChange={(e) => setInvitees((c) => e.target.checked ? [...c, m._id] : c.filter((id) => id !== m._id))} />{getUserDisplayName(m)}</label>)}</div>
        <button type="button" disabled={busy || !invitees.length} className="ui-secondary-button mt-2 px-3 py-1.5 text-xs" onClick={() => void run(() => api.post(`/dms/${dm._id}/participants`, { userIds: invitees }), () => setInvitees([]))}>Add selected</button></section>}
      <div className="border-t border-[var(--border)] pt-4">{confirmLeave
        ? <div className="flex flex-wrap items-center gap-2"><span className="text-xs">Leave this group?</span><button type="button" disabled={busy} className="ui-primary-button px-3 py-1.5 text-xs" onClick={() => void run(() => api.delete(`/dms/${dm._id}/participants/${currentUserId}`), onLeft)}>Yes, leave</button><button type="button" className="ui-secondary-button px-3 py-1.5 text-xs" onClick={() => setConfirmLeave(false)}>Cancel</button></div>
        : <button type="button" className="ui-secondary-button px-3 py-1.5 text-xs" onClick={() => setConfirmLeave(true)}>Leave group</button>}</div>
    </div>
  </Modal>;
}
