import { useCallback, useEffect, useState } from 'react';
import Modal from '../common/Modal';
import Avatar from '../common/Avatar';
import { api } from '../../hooks/useAuth';
import type { User } from '../../types';
import { getUserDisplayName } from '../../utils/userDisplay';

type Member = { user: User; role: 'owner' | 'admin' | 'member' | 'guest' };
interface Props { workspaceId: string; workspaceName: string; currentUserId: string; onClose: () => void; onLeft: () => void; onChanged: () => void }

export default function WorkspaceMembersModal({ workspaceId, workspaceName, currentUserId, onClose, onLeft, onChanged }: Props) {
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: 'remove' | 'transfer' | 'leave'; user?: User } | null>(null);
  const [typedName, setTypedName] = useState('');
  const load = useCallback(async () => {
    try { const { data } = await api.get(`/workspaces/${workspaceId}/members`); setMembers((data.members as Member[]).filter((m) => m.user)); }
    catch (err: any) { setError(err.response?.data?.error || 'Unable to load members'); }
  }, [workspaceId]);
  useEffect(() => { void load(); }, [load]);
  const me = members.find((m) => m.user._id === currentUserId)?.role;
  const isOwner = me === 'owner'; const isAdmin = me === 'admin' || isOwner;
  const run = async (action: () => Promise<unknown>, after?: () => void) => {
    setBusy(true); setError('');
    try { await action(); setConfirm(null); setTypedName(''); await load(); onChanged(); after?.(); }
    catch (err: any) { setError(err.response?.data?.error || 'That did not work. Please try again.'); }
    finally { setBusy(false); }
  };
  const order = { owner: 0, admin: 1, member: 2, guest: 3 } as const;
  return <Modal title={`${workspaceName} members`} onClose={onClose}>
    <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
      {error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      <ul className="space-y-2">{[...members].sort((a, b) => order[a.role] - order[b.role] || getUserDisplayName(a.user).localeCompare(getUserDisplayName(b.user))).map((member) => {
        const self = member.user._id === currentUserId;
        const canRemove = !self && member.role !== 'owner' && (isOwner || (me === 'admin' && member.role !== 'admin'));
        return <li key={member.user._id} className="flex flex-wrap items-center gap-2 text-sm">
          <Avatar user={member.user} size="sm" /><span className="min-w-0 flex-1 truncate">{getUserDisplayName(member.user)}{self ? ' (you)' : ''}</span>
          <span className="rounded bg-[var(--primary-soft)] px-1.5 py-0.5 text-[10px] font-semibold capitalize text-[var(--accent)]">{member.role}</span>
          {isOwner && !self && member.role !== 'owner' && <button type="button" disabled={busy} className="text-[11px] text-[var(--accent)] hover:underline" onClick={() => void run(() => api.put(`/workspaces/${workspaceId}/members/${member.user._id}/role`, { role: member.role === 'admin' ? 'member' : 'admin' }))}>{member.role === 'admin' ? 'Make member' : 'Make admin'}</button>}
          {isOwner && !self && <button type="button" disabled={busy} className="text-[11px] text-[var(--accent)] hover:underline" onClick={() => setConfirm({ kind: 'transfer', user: member.user })}>Make owner</button>}
          {canRemove && <button type="button" disabled={busy} className="text-[11px] text-[var(--error)] hover:underline" onClick={() => setConfirm({ kind: 'remove', user: member.user })}>Remove</button>}
        </li>;
      })}</ul>
      {confirm?.kind === 'remove' && confirm.user && <div className="rounded-md border border-[var(--border)] p-3 text-xs"><p>Remove <strong>{getUserDisplayName(confirm.user)}</strong> from the workspace? They lose access to all channels and conversations.</p><div className="mt-2 flex gap-2"><button type="button" disabled={busy} className="ui-primary-button px-3 py-1.5" onClick={() => void run(() => api.delete(`/workspaces/${workspaceId}/members/${confirm.user!._id}`))}>Remove</button><button type="button" className="ui-secondary-button px-3 py-1.5" onClick={() => setConfirm(null)}>Cancel</button></div></div>}
      {confirm?.kind === 'transfer' && confirm.user && <div className="rounded-md border border-[var(--border)] p-3 text-xs"><p>Transfer ownership to <strong>{getUserDisplayName(confirm.user)}</strong>? You will become an admin. Type <strong>{workspaceName}</strong> to confirm.</p><input className="mt-2 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5" value={typedName} onChange={(e) => setTypedName(e.target.value)} aria-label="Workspace name" /><div className="mt-2 flex gap-2"><button type="button" disabled={busy || typedName !== workspaceName} className="ui-primary-button px-3 py-1.5" onClick={() => void run(() => api.post(`/workspaces/${workspaceId}/transfer-ownership`, { userId: confirm.user!._id, confirmName: typedName }))}>Transfer ownership</button><button type="button" className="ui-secondary-button px-3 py-1.5" onClick={() => setConfirm(null)}>Cancel</button></div></div>}
      <div className="border-t border-[var(--border)] pt-3">
        {isAdmin && !isOwner && <p className="mb-2 text-[11px] text-[var(--text-muted)]">Admins can remove members; only the owner changes roles.</p>}
        {me === 'owner' ? <p className="text-[11px] text-[var(--text-muted)]">You are the owner. Transfer ownership before leaving.</p>
          : confirm?.kind === 'leave' ? <div className="flex flex-wrap items-center gap-2 text-xs"><span>Leave {workspaceName}?</span><button type="button" disabled={busy} className="ui-primary-button px-3 py-1.5" onClick={() => void run(() => api.post(`/workspaces/${workspaceId}/leave`), onLeft)}>Yes, leave</button><button type="button" className="ui-secondary-button px-3 py-1.5" onClick={() => setConfirm(null)}>Cancel</button></div>
          : <button type="button" className="ui-secondary-button px-3 py-1.5 text-xs" onClick={() => setConfirm({ kind: 'leave' })}>Leave workspace</button>}
      </div>
    </div>
  </Modal>;
}
