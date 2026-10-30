import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import AuthLayout from '../components/auth/AuthLayout';
import { api } from '../hooks/useAuth';

type RequestInfo = { id: string; employee: string; email: string; requestedAt: string; userAgent?: string; requestIp?: string };

export default function RecoveryApproval() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [request, setRequest] = useState<RequestInfo | null>(null);
  const [handled, setHandled] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) { setError('This approval link is invalid or expired.'); return; }
    void api.get('/auth/password-resets/approval?token=' + encodeURIComponent(token)).then((response) => {
      if (response.data.handled) { setHandled(true); setStatus(response.data.status || 'handled'); }
      else setRequest(response.data.request);
    }).catch((cause: any) => setError(cause.response?.data?.error || 'This approval link is invalid or expired.'));
  }, [token]);

  const decide = async (action: 'approve' | 'reject') => {
    setBusy(true); setError('');
    try {
      const response = await api.post('/auth/password-resets/approval/' + action, { token });
      setStatus(response.data.status || action);
      setHandled(true);
      setRequest(null);
    } catch (cause: any) { setError(cause.response?.data?.error || 'This recovery request has already been handled.'); }
    finally { setBusy(false); }
  };

  return <AuthLayout title="Unichat Security" subtitle="Password recovery request" error={error} footer={<p className="mt-6 text-center text-sm"><Link to="/login" className="font-semibold text-[var(--accent)]">Return to sign in</Link></p>}>
    {request && <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 text-sm"><div><p className="text-xs text-[var(--text-muted)]">Employee</p><p className="font-semibold">{request.employee}</p></div><div><p className="text-xs text-[var(--text-muted)]">Email</p><p>{request.email}</p></div><div><p className="text-xs text-[var(--text-muted)]">Requested</p><p>{new Date(request.requestedAt).toLocaleString()}</p></div><div><p className="text-xs text-[var(--text-muted)]">Device</p><p className="break-words">{request.userAgent || 'Unknown'}</p></div><div><p className="text-xs text-[var(--text-muted)]">IP address</p><p>{request.requestIp || 'Unknown'}</p></div><div className="flex gap-2 pt-3"><button type="button" disabled={busy} onClick={() => void decide('reject')} className="flex-1 rounded-md border border-[var(--border)] px-3 py-2 text-sm font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50">Reject</button><button type="button" disabled={busy} onClick={() => void decide('approve')} className="flex-1 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">{busy ? 'Saving…' : 'Approve recovery'}</button></div></div>}
    {handled && <div className="rounded-lg border border-[var(--border)] bg-[var(--primary-soft)] p-4 text-sm text-[var(--text-primary)]" role="status">This recovery request has already been handled ({status}).</div>}
    {!request && !handled && !error && <p className="text-sm text-[var(--text-secondary)]">Loading request…</p>}
  </AuthLayout>;
}
