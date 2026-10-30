import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import AuthLayout from '../components/auth/AuthLayout';
import GoogleSignIn from '../components/auth/GoogleSignIn';
import { useAuth } from '../hooks/useAuth';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError(''); setSaving(true);
    try {
      const user = await login(email.trim(), password);
      const returnTo = searchParams.get('returnTo');
      const safe = returnTo && /^\/(?!\/)/.test(returnTo) && !returnTo.includes('\\') ? returnTo : '';
      navigate(safe || (user.role === 'SUPER_ADMIN' ? '/admin' : '/workspaces'));
    } catch (cause: any) { setError(cause.response?.data?.error || 'Unable to sign in. Check your connection and try again.'); }
    finally { setSaving(false); }
  };
  return <AuthLayout title="Welcome back." subtitle="Sign in to find your people and pick up where you left off." error={error} footer={<p className="mt-7 text-center text-sm text-[var(--text-secondary)]">New to Unichat? <Link className="auth-link" to="/register">Create an account</Link></p>}><GoogleSignIn/><form onSubmit={(event) => void submit(event)} className="space-y-5"><label className="auth-label">Email address<input type="email" className="auth-input" autoComplete="email" placeholder="you@example.com" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} required/></label><div><div className="flex items-center justify-between"><label className="auth-label" htmlFor="password">Password</label><Link className="auth-link text-xs" to="/forgot-password">Forgot password?</Link></div><div className="relative"><input id="password" type={showPassword ? 'text' : 'password'} className="auth-input pr-16" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required/><button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute right-3 top-4 text-xs font-medium text-[var(--text-secondary)]" aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? 'Hide' : 'Show'}</button></div></div><button disabled={saving} className="auth-submit">{saving ? 'Signing in…' : 'Sign in to Unichat'}</button></form></AuthLayout>;
}
