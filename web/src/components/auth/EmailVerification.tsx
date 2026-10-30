import { useEffect, useState } from 'react';
import { api } from '../../hooks/useAuth';

export default function EmailVerification({ email, onVerified, onBack }: { email: string; onVerified: (token: string) => Promise<void>; onBack: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [remaining, setRemaining] = useState(60);
  useEffect(() => { const timer = window.setInterval(() => setRemaining((value) => Math.max(0, value - 1)), 1000); return () => clearInterval(timer); }, []);
  const verify = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await api.post('/auth/email-verification/verify', { email, code }); await onVerified(result.data.emailVerificationToken); }
    catch (cause: any) { setError(cause.response?.data?.error || 'Unable to verify your code. Please try again.'); }
    finally { setBusy(false); }
  };
  const resend = async () => { setBusy(true); setError(''); try { await api.post('/auth/email-verification/request', { email }); setRemaining(60); setCode(''); } catch (cause: any) { setError(cause.response?.data?.error || 'Unable to send another code.'); } finally { setBusy(false); } };
  return <form onSubmit={(event) => void verify(event)} className="space-y-5"><p className="text-sm leading-6 text-[var(--text-secondary)]">Enter the six-digit code sent to <strong className="break-all text-[var(--text)]">{email}</strong>. It expires in 10 minutes.</p>{error && <p role="alert" className="text-sm text-[var(--error-text)]">{error}</p>}<label className="auth-label">Verification code<input autoFocus className="auth-input text-center font-mono text-xl tracking-[.4em]" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} required /></label><button disabled={busy} className="auth-submit">{busy ? 'Verifying…' : 'Verify and continue'}</button><div className="flex justify-between text-sm"><button type="button" onClick={onBack} disabled={busy} className="text-[var(--text-secondary)]">Back</button><button type="button" onClick={() => void resend()} disabled={busy || remaining > 0} className="font-medium text-[var(--accent)] disabled:text-[var(--text-muted)]">{remaining ? `Resend in ${remaining}s` : 'Resend code'}</button></div></form>;
}
