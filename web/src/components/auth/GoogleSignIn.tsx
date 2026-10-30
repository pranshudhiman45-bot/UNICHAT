import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, useAuth } from '../../hooks/useAuth';
import EmailVerification from './EmailVerification';

type GoogleIdentity = { initialize: (options: { client_id: string; callback: (response: { credential: string }) => void; auto_select: boolean }) => void; renderButton: (element: HTMLElement, options: Record<string, unknown>) => void };
declare global { interface Window { google?: { accounts: { id: GoogleIdentity } } } }
let scriptPromise: Promise<void> | null = null;
function loadGoogle() {
  if (window.google?.accounts.id) return Promise.resolve();
  if (!scriptPromise) scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script'); script.src = 'https://accounts.google.com/gsi/client'; script.async = true; script.onload = () => resolve(); script.onerror = () => { script.remove(); scriptPromise = null; reject(new Error('Unable to load Google sign-in')); }; document.head.appendChild(script);
  });
  return scriptPromise;
}
export default function GoogleSignIn() {
  const { config, googleLogin } = useAuth();
  const element = useRef<HTMLDivElement>(null);
  const loginRef = useRef(googleLogin); loginRef.current = googleLogin;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ email: string; credential: string } | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    if (!config?.googleEnabled || !config.googleClientId || pending) return;
    let cancelled = false;
    void loadGoogle().then(() => {
      if (cancelled || !element.current) return;
      window.google?.accounts.id.initialize({ client_id: config.googleClientId, auto_select: false, callback: async ({ credential }) => {
        if (cancelled) return;
        setBusy(true); setError('');
        try { await loginRef.current(credential); navigate('/workspaces'); }
        catch (cause: any) {
          if (cause.response?.data?.code === 'EMAIL_VERIFICATION_REQUIRED') {
            const email = cause.response.data.email;
            try { await api.post('/auth/email-verification/request', { email }); setPending({ email, credential }); }
            catch { setError('Unable to send a verification code. Please try again.'); }
          } else setError(cause.response?.data?.error || 'Google sign-in failed. Please try again.');
        } finally { setBusy(false); }
      } });
      window.google?.accounts.id.renderButton(element.current, { theme: 'outline', size: 'large', shape: 'rectangular', width: Math.min(384, element.current.clientWidth || 300), text: 'continue_with' });
    }).catch(() => { if (!cancelled) setError('Google sign-in is unavailable. You can still sign in with email.'); });
    return () => { cancelled = true; };
  }, [config?.googleEnabled, config?.googleClientId, navigate, pending]);
  if (!config?.googleEnabled) return null;
  return <div className="mb-6">{pending ? <EmailVerification email={pending.email} onBack={() => setPending(null)} onVerified={async (token) => { await googleLogin(pending.credential, token); navigate('/workspaces'); }}/> : <div ref={element} className={busy ? 'pointer-events-none opacity-50' : ''}/>} {busy && <p role="status" className="mt-2 text-xs text-[var(--text-secondary)]">Connecting your account…</p>}{error && <p role="alert" className="mt-2 text-sm text-[var(--error-text)]">{error}</p>}<div className="my-6 flex items-center gap-3 text-xs text-[var(--text-muted)]"><span className="h-px flex-1 bg-[var(--border)]"/>or continue with email<span className="h-px flex-1 bg-[var(--border)]"/></div></div>;
}
