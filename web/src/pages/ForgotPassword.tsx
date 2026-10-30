import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import AuthLayout from '../components/auth/AuthLayout';
import { api, useAuth } from '../hooks/useAuth';

type Step = 'request' | 'code' | 'password' | 'done';
const field = 'mt-1.5 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none';

export default function ForgotPassword() {
  const { config } = useAuth();
  const adminMode = config?.passwordRecoveryMode === 'admin';
  const [remaining, setRemaining] = useState(0);
  useEffect(() => { const timer = setInterval(() => setRemaining((value) => Math.max(0, value - 1)), 1000); return () => clearInterval(timer); }, []);
  const [step, setStep] = useState<Step>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      if (step === 'request') {
        await api.post('/auth/password-resets/request', { email: email.trim() });
        setStep('code'); setRemaining(60);
      } else if (step === 'code') {
        const response = await api.post('/auth/password-resets/verify', { email: email.trim(), code });
        setResetToken(response.data.resetToken);
        setCode('');
        setStep('password');
      } else if (step === 'password') {
        if (password.length < 10 || password !== confirmPassword) { setError('Passwords must match and be at least 10 characters.'); return; }
        await api.post('/auth/password-resets/complete', { email: email.trim(), resetToken, password, confirmPassword });
        setResetToken(''); setPassword(''); setConfirmPassword(''); setStep('done');
      }
    } catch (cause: any) { setError(cause.response?.data?.error || 'Unable to continue. Please try again.'); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (step !== 'code' || !adminMode) return;
    let stopped = false;
    const check = async () => {
      try {
        const response = await api.get('/auth/password-resets/status');
        if (stopped) return;
        if (response.data.status === 'approved') setApproved(true);
        else if (['rejected', 'expired', 'locked'].includes(response.data.status)) setError('This recovery request is no longer active. Please submit a new request.');
      } catch { /* Keep the generic waiting state while the request remains private. */ }
    };
    void check();
    const timer = window.setInterval(() => void check(), 4000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [step, adminMode]);
  const subtitle = step === 'request' ? (adminMode ? 'Ask an administrator to help you recover your account.' : 'Enter your email and we’ll send you a one-time recovery code.') : step === 'code' ? (adminMode ? (approved ? 'Your request was approved. Enter the six-digit code emailed to you, or given to you by your administrator.' : 'Waiting for administrator approval. Once approved, enter the code sent to your email or provided by your administrator.') : 'If an eligible account exists, a six-digit code is on its way. Check your inbox and spam folder.') : step === 'password' ? 'Choose a new password for your account.' : 'Your password has been updated. Sign in again.';
  return <AuthLayout title="Recover your account" subtitle={subtitle} error={error} footer={<p className="mt-6 text-center text-sm"><Link to="/login" className="font-semibold text-[var(--accent)]">Back to sign in</Link></p>}>
    {step === 'done' ? <p className="rounded-md bg-[var(--primary-soft)] p-4 text-sm text-[var(--text-primary)]" role="status">Password updated. All existing sessions have been signed out.</p> :
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        {step === 'request' && <label className="block text-sm font-medium text-[var(--text-secondary)]">Account email<input className={field} type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} /></label>}
        {step === 'code' && <label className="block text-sm font-medium text-[var(--text-secondary)]">Six-digit recovery code<input className={`${field} font-mono text-center text-lg tracking-[.35em]`} type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} required aria-describedby="code-help" /><span id="code-help" className="mt-1 block text-xs text-[var(--text-muted)]">{adminMode ? 'Use the code provided by your administrator.' : 'Codes expire in 10 minutes. Only the most recent code works.'}</span></label>}
        {step === 'password' && <><label className="block text-sm font-medium text-[var(--text-secondary)]">New password<input className={field} type="password" autoComplete="new-password" minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} required /></label><label className="block text-sm font-medium text-[var(--text-secondary)]">Confirm new password<input className={field} type="password" autoComplete="new-password" minLength={10} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></label></>}
        <button type="submit" disabled={busy} className="w-full rounded-md bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50">{busy ? 'Please wait…' : step === 'request' ? 'Send recovery code' : step === 'code' ? 'Verify code' : 'Update password'}</button>
        {step === 'code' && <div className="flex justify-between text-sm"><button type="button" onClick={() => { setStep('request'); setError(''); }}>Change email</button><button type="button" disabled={busy || remaining > 0} className="auth-link disabled:opacity-50" onClick={async () => { setBusy(true); setError(''); try { await api.post('/auth/password-resets/request', { email: email.trim() }); setRemaining(60); setCode(''); } catch { setError('Unable to resend. Please try again later.'); } finally { setBusy(false); } }}>{remaining ? `Resend in ${remaining}s` : 'Resend code'}</button></div>}
      </form>}
  </AuthLayout>;
}
