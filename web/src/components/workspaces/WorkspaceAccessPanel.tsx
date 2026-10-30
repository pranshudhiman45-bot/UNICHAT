import { useCallback, useEffect, useState } from 'react';
import { api, getAccessToken } from '../../hooks/useAuth';
import { connectSocket } from '../../services/socket';
import type { Workspace } from '../../types';

export default function WorkspaceAccessPanel({ workspace, onClose, onChanged }: { workspace: Workspace; onClose: () => void; onChanged: () => void }) {
  const [requests, setRequests] = useState<any[]>([]);
  const [code, setCode] = useState(workspace.inviteCode);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    try { const { data } = await api.get(`/workspaces/${workspace._id}/join-requests`); setRequests(data.requests); setError(''); }
    catch (e: any) { setError(e.response?.data?.error || 'Unable to load join requests.'); }
    finally { setLoading(false); }
  }, [workspace._id]);
  useEffect(() => {
    void load();
    const socket = connectSocket(getAccessToken());
    const refresh = (event: { workspaceId: string }) => { if (event.workspaceId === workspace._id) void load(); };
    socket.on('workspace:join_request', refresh);
    const timer = window.setInterval(() => void load(), 30000);
    return () => { socket.off('workspace:join_request', refresh); window.clearInterval(timer); };
  }, [load, workspace._id]);
  const decide = async (requestId: string, decision: 'approve' | 'reject') => {
    setBusy(requestId); setError(''); setNotice('');
    try {
      await api.post(`/workspaces/${workspace._id}/join-requests/${requestId}/${decision}`);
      setRequests(current => current.filter(request => request._id !== requestId));
      setNotice(decision === 'approve' ? 'Member approved. They can now open the workspace.' : 'Request rejected. Workspace access was not granted.');
      onChanged();
    } catch (e: any) { setError(e.response?.data?.error || 'Unable to review this request.'); }
    finally { setBusy(''); }
  };
  return <section aria-label={`Manage access to ${workspace.name}`} className="mb-6 rounded-xl border border-[var(--accent)] bg-[var(--surface)] p-5 text-[var(--text)]">
    <div className="flex items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Manage access · {workspace.name}</h2><p className="mt-1 text-sm text-[var(--text-secondary)]">You are a workspace administrator. An invite code submits a request; your approval grants access.</p></div><button className="ui-secondary-button px-3 py-2" onClick={onClose}>Close</button></div>
    <div className="my-5 flex flex-wrap items-center gap-3 rounded-lg bg-[var(--bg-surface-secondary)] p-4"><span className="text-sm">Invite code</span><code className="select-all font-mono font-semibold tracking-wider">{code}</code><button className="ui-secondary-button px-3 py-2 text-xs" onClick={async () => { try { await navigator.clipboard.writeText(code || ''); setNotice('Invite code copied.'); } catch { setError('Select the invite code and copy it manually.'); } }}>Copy code</button><button className="ui-secondary-button px-3 py-2 text-xs" disabled={!!busy} onClick={async () => { if (!window.confirm('Replace the invite code? Existing pending requests will still need a decision.')) return; setBusy('rotate'); try { const { data } = await api.post(`/workspaces/${workspace._id}/regenerate-invite`); setCode(data.inviteCode); setNotice('Invite code replaced.'); onChanged(); } catch (e: any) { setError(e.response?.data?.error || 'Unable to replace code.'); } finally { setBusy(''); } }}>Replace code</button></div>
    {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
    {notice && <p role="status" className="mb-3 text-sm text-[var(--text-secondary)]">{notice}</p>}
    <div className="flex items-center justify-between"><h3 className="font-semibold">Join requests ({requests.length})</h3><button className="text-sm text-[var(--accent)]" onClick={() => void load()}>Refresh requests</button></div>
    {loading ? <p className="mt-3 text-sm">Loading requests…</p> : !requests.length ? <p className="mt-3 text-sm text-[var(--text-secondary)]">No pending requests.</p> : <ul className="mt-3 divide-y divide-[var(--border)]">{requests.map(request => <li key={request._id} className="flex flex-wrap items-center justify-between gap-4 py-4"><div className="min-w-0"><p className="font-semibold">{request.user.displayName}</p><p className="break-all text-sm text-[var(--text-secondary)]">@{request.user.username} · {request.user.email}</p><p className="mt-1 text-xs text-[var(--text-muted)]">{request.user.emailVerifiedAt ? 'Email verified' : 'Email not verified'} · Requested {new Date(request.requestedAt).toLocaleString()}</p></div><div className="flex gap-2"><button aria-label={`Reject ${request.user.displayName}`} disabled={!!busy} className="ui-secondary-button px-4 py-2 text-sm" onClick={() => void decide(request._id, 'reject')}>Reject</button><button aria-label={`Approve ${request.user.displayName}`} disabled={!!busy} className="ui-primary-button px-4 py-2 text-sm" onClick={() => void decide(request._id, 'approve')}>{busy === request._id ? 'Saving…' : 'Approve'}</button></div></li>)}</ul>}
  </section>;
}
