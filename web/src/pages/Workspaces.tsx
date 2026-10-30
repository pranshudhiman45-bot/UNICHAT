import WorkspaceAccessPanel from '../components/workspaces/WorkspaceAccessPanel';
import { connectSocket, disconnectSocket } from '../services/socket';
import { getAccessToken } from '../hooks/useAuth';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth, api } from '../hooks/useAuth';
import type { Workspace } from '../types';
import LogoutDialog from '../components/common/LogoutDialog';
import UiIcon from '../components/common/UiIcon';
import EditProfileDialog from '../components/profile/EditProfileDialog';
import WorkspaceAvatar from '../components/common/WorkspaceAvatar';

export default function Workspaces() {
  const [searchParams] = useSearchParams();
  const [manageId, setManageId] = useState(searchParams.get('review') || '');
  const [requests, setRequests] = useState<any[]>([]);
  const [notice, setNotice] = useState('');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [newWorkspaceDesc, setNewWorkspaceDesc] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [activeForm, setActiveForm] = useState<'create' | 'join' | null>(null);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const { user, logout, config } = useAuth();
  const navigate = useNavigate();

  const fetchWorkspaces = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [response, pending] = await Promise.all([api.get('/workspaces'), api.get('/workspaces/join-requests')]);
      setRequests(pending.data.requests);
      setWorkspaces(response.data.workspaces);
      setError('');
    } catch (cause: any) {
      setError(cause.response?.data?.error || 'Unable to load workspaces.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void fetchWorkspaces();
    const socket = connectSocket(getAccessToken());
    const refresh = () => void fetchWorkspaces(true);
    socket.on('workspace:join_request', refresh); socket.on('workspace:join_decided', refresh); socket.on('connect', refresh);
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(refresh, 30000);
    return () => { socket.off('workspace:join_request', refresh); socket.off('workspace:join_decided', refresh); socket.off('connect', refresh); window.removeEventListener('focus', refresh); window.clearInterval(timer); disconnectSocket(); };
  }, [fetchWorkspaces]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !newWorkspaceName.trim()) return;
    setSaving(true); setError('');
    try {
      const response = await api.post('/workspaces', { name: newWorkspaceName.trim(), description: newWorkspaceDesc.trim() });
      setNewWorkspaceName(''); setNewWorkspaceDesc(''); setActiveForm(null);
      navigate(`/chat/${response.data.workspace._id}`);
    } catch (cause: any) { setError(cause.response?.data?.error || 'Unable to create workspace.'); }
    finally { setSaving(false); }
  };
  const join = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !joinCode.trim()) return;
    setSaving(true); setError('');
    try {
      const response = await api.post(`/workspaces/join/${encodeURIComponent(joinCode.trim().toUpperCase())}`);
      setJoinCode(''); setActiveForm(null);
      if (response.data.alreadyMember) navigate(`/chat/${response.data.workspace._id}`);
      else { setNotice(response.data.message); await fetchWorkspaces(true); }
    } catch (cause: any) { setError(cause.response?.data?.error || 'Unable to join workspace.'); }
    finally { setSaving(false); }
  };

  if (!user) return null;
  const canManage = (workspace: Workspace) => workspace.members?.some(member => String(typeof member.user === 'object' ? member.user?._id : member.user) === user._id && ['owner', 'admin'].includes(member.role));
  const managedWorkspace = workspaces.find(workspace => workspace._id === manageId && canManage(workspace));
  return <div className="workspace-page min-h-dvh">
    <header className="border-b border-[var(--border)] bg-[var(--surface)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4">
        <div className="flex items-center gap-2.5"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] text-sm font-bold text-white">U</span><span className="text-lg font-bold tracking-tight text-[var(--text)]">Unichat</span></div>
        <div className="flex items-center gap-3"><span className="hidden text-xs text-[var(--text-secondary)] sm:inline">{user.displayName}</span>{user.role === 'SUPER_ADMIN' && <button type="button" onClick={() => navigate('/admin')} className="rounded-md border border-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]">Admin</button>}<button type="button" onClick={() => setEditProfileOpen(true)} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--bg-surface-secondary)]">Edit profile</button><button type="button" onClick={() => setLogoutOpen(true)} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--bg-surface-secondary)]">Log out</button></div>
      </div>
    </header>
    <main className="mx-auto max-w-6xl px-5 py-8 sm:py-10">
      <div className="mb-7 flex flex-wrap items-center justify-between gap-4">
        <div><h1 className="text-[22px] font-semibold tracking-tight text-[var(--text)]">Your workspaces</h1><p className="mt-1 text-sm text-[var(--text-secondary)]">Pick a team to continue the conversation.</p></div>
        <div className="flex flex-wrap gap-2"><button type="button" onClick={() => { setError(''); setActiveForm((current) => current === 'join' ? null : 'join'); }} className="rounded-md border border-[var(--accent)] px-3.5 py-2 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--bg-surface-secondary)]">Join with code</button>{(config?.workspaceCreation !== 'admin' || user.role === 'SUPER_ADMIN') && <button type="button" onClick={() => { setError(''); setActiveForm((current) => current === 'create' ? null : 'create'); }} className="rounded-md bg-[var(--accent)] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[var(--accent-hover)]">Create workspace</button>}</div>
      </div>
      {notice && <p role="status" className="mb-5 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">{notice}</p>}
      {managedWorkspace && <WorkspaceAccessPanel key={managedWorkspace._id} workspace={managedWorkspace} onClose={() => setManageId('')} onChanged={() => void fetchWorkspaces(true)} />}
      {requests.filter(request => request.status !== 'approved').length > 0 && <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5" aria-label="Your join requests"><h2 className="font-semibold">Your join requests</h2>{requests.filter(request => request.status !== 'approved').map(request => <div key={request._id} className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm"><span>{request.workspace.name}</span><span className="text-[var(--text-secondary)]">{request.status === 'pending' ? 'Waiting for administrator approval' : (request.canRequestAgainAt && new Date(request.canRequestAgainAt) > new Date() ? `Request declined · you can ask again after ${new Date(request.canRequestAgainAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'Request declined · you can ask again with the workspace code')}</span></div>)}</section>}
      {error && <div className="mb-5 flex items-center justify-between gap-3 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-xs text-red-800" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} className="rounded p-1 hover:bg-red-100" aria-label="Dismiss error"><UiIcon name="close" size={15} /></button></div>}
      {activeForm === 'create' && <form onSubmit={(event) => void create(event)} className="mb-6 max-w-xl rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5"><h2 className="mb-4 text-sm font-semibold">Create a workspace</h2><label className="mb-3 block text-xs font-medium text-[var(--text-secondary)]">Workspace name<input autoFocus value={newWorkspaceName} onChange={(event) => setNewWorkspaceName(event.target.value)} minLength={2} maxLength={80} required className="mt-1.5 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]" /></label><label className="block text-xs font-medium text-[var(--text-secondary)]">Description (optional)<input value={newWorkspaceDesc} onChange={(event) => setNewWorkspaceDesc(event.target.value)} maxLength={300} className="mt-1.5 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]" /></label><div className="mt-4 flex gap-2"><button type="submit" disabled={saving} className="rounded-md bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">{saving ? 'Creating…' : 'Create'}</button><button type="button" onClick={() => setActiveForm(null)} disabled={saving} className="rounded-md border border-[var(--border)] px-4 py-2 text-xs text-[var(--text-secondary)]">Cancel</button></div></form>}
      {activeForm === 'join' && <form onSubmit={(event) => void join(event)} className="mb-6 max-w-xl rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5"><h2 className="mb-2 text-sm font-semibold">Request to join a workspace</h2><p className="mb-4 text-sm text-[var(--text-secondary)]">The administrator will review your request before you can see conversations.</p><label className="block text-xs font-medium text-[var(--text-secondary)]">Invite code<input autoFocus value={joinCode} onChange={(event) => setJoinCode(event.target.value)} maxLength={40} required autoComplete="off" className="mt-1.5 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-sm uppercase text-[var(--text)]" /></label><div className="mt-4 flex gap-2"><button type="submit" disabled={saving} className="rounded-md bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">{saving ? 'Sending…' : 'Request to join'}</button><button type="button" onClick={() => setActiveForm(null)} disabled={saving} className="rounded-md border border-[var(--border)] px-4 py-2 text-xs text-[var(--text-secondary)]">Cancel</button></div></form>}
      {loading ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Loading workspaces">{[1, 2, 3].map((item) => <div key={item} className="h-40 animate-pulse rounded-xl border border-[var(--border)] bg-[var(--surface)]" />)}</div> : workspaces.length ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{workspaces.map((workspace) => <div key={workspace._id}><button type="button" onClick={() => navigate(`/chat/${workspace._id}`)} className="group flex w-full min-h-40 flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 text-left transition-colors duration-150 hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]"><div className="flex w-full items-start justify-between gap-2"><WorkspaceAvatar workspace={workspace} /><span className="rounded-full border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)]">{workspace.members?.length ?? 0} {(workspace.members?.length ?? 0) === 1 ? 'member' : 'members'}</span></div><span className="mt-4 truncate text-base font-semibold text-[var(--text)] group-hover:text-[var(--accent)]">{workspace.name}</span><span className="mt-1 line-clamp-2 text-xs text-[var(--text-secondary)]">{workspace.description || 'Open workspace'}</span></button>{canManage(workspace) && <button onClick={() => { setManageId(workspace._id); window.scrollTo({ top: 0, behavior: 'smooth' }); }} className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold text-[var(--accent)]">Manage access{workspace.pendingJoinRequestCount ? ` · ${workspace.pendingJoinRequestCount} pending` : ''}</button>}</div>)}</div> : <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-12 text-center"><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--bg-surface-secondary)] text-[var(--accent)]"><UiIcon name="grid" size={24} /></span><h2 className="mt-3 text-sm font-semibold">No workspaces yet</h2><p className="mt-1 text-xs text-[var(--text-secondary)]">Create one or join your team with an invite code.</p></div>}
    </main>
    {logoutOpen && <LogoutDialog onClose={() => setLogoutOpen(false)} onLogout={logout} />}
    {editProfileOpen && <EditProfileDialog onClose={() => setEditProfileOpen(false)} />}
  </div>;
}
