import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AuthLayout from '../components/auth/AuthLayout';
import GoogleSignIn from '../components/auth/GoogleSignIn';
import EmailVerification from '../components/auth/EmailVerification';
import { api, useAuth } from '../hooks/useAuth';

type Field = 'username' | 'email' | 'password' | 'displayName';
export default function Register() {
  const [form, setForm] = useState({ username: '', email: '', password: '', displayName: '' });
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const { register, config } = useAuth();
  const navigate = useNavigate();
  const update = (field: Field, value: string) => {
    setForm(current => ({ ...current, [field]: value }));
    setFieldErrors(current => ({ ...current, [field]: undefined }));
    setError('');
  };
  const complete = async (emailVerificationToken?: string) => {
    await register({ ...form, email: form.email.trim().toLowerCase(), username: form.username.trim().toLowerCase(), displayName: form.displayName.trim(), emailVerificationToken });
    navigate('/workspaces');
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError('');
    const invalid: Partial<Record<Field, string>> = {};
    if (!form.displayName.trim() || form.displayName.trim().length > 50) invalid.displayName = 'Enter your full name (1–50 characters).';
    if (!/^[a-zA-Z0-9_.-]{2,30}$/.test(form.username.trim())) invalid.username = 'Choose a username such as pranshu45. Use 2–30 letters, numbers, dots, underscores or hyphens; no @ or spaces.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) invalid.email = 'Enter a valid email address.';
    if (form.password.length < 10) invalid.password = 'Your password needs at least 10 characters.';
    else if (new TextEncoder().encode(form.password).length > 72) invalid.password = 'Your password is too long. Use at most 72 UTF-8 bytes.';
    setFieldErrors(invalid);
    const first = Object.keys(invalid)[0] as Field | undefined;
    if (first) { document.getElementById(`register-${first}`)?.focus(); return; }
    setSaving(true);
    try {
      const currentConfig = config || (await api.get('/auth/config')).data;
      if (currentConfig.emailVerificationRequired === false) await complete();
      else { await api.post('/auth/email-verification/request', { email: form.email.trim() }); setVerifying(true); }
    } catch (cause: any) {
      const data = cause.response?.data;
      const fields: Partial<Record<Field, string>> = {};
      for (const detail of data?.details || []) {
        const field = detail.field || detail.path;
        if (['username', 'email', 'password', 'displayName'].includes(field)) fields[field as Field] = detail.message || detail.msg;
      }
      setFieldErrors(fields);
      setError(data?.error || 'Unable to create your account. Please try again.');
    } finally { setSaving(false); }
  };
  const fieldError = (field: Field) => fieldErrors[field] ? <span id={`register-${field}-error`} role="alert" className="mt-2 block text-xs font-normal text-red-600">{fieldErrors[field]}</span> : null;
  const accessibility = (field: Field) => ({ id: `register-${field}`, name: field, 'aria-label': { displayName: 'Full name', username: 'Username', email: 'Email address', password: 'Password' }[field], 'aria-invalid': !!fieldErrors[field], 'aria-describedby': fieldErrors[field] ? `register-${field}-error` : ['username', 'password'].includes(field) ? `${field}-hint` : undefined });
  return <AuthLayout title={verifying ? 'Check your inbox.' : 'Your next great team starts here.'} subtitle={verifying ? 'One quick step to confirm it’s you.' : 'Create your account, then start a workspace or join your team.'} error={error} footer={<p className="mt-7 text-center text-sm text-[var(--text-secondary)]">Already have an account? <Link className="auth-link" to="/login">Sign in</Link></p>}>
    {verifying ? <EmailVerification email={form.email.trim().toLowerCase()} onBack={() => { setVerifying(false); setError(''); }} onVerified={complete}/> : <>
      <GoogleSignIn/>
      <form noValidate onSubmit={event => void submit(event)} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-3">
          <label className="auth-label" htmlFor="register-displayName">Full name
            <input {...accessibility('displayName')} className="auth-input" autoComplete="name" maxLength={50} value={form.displayName} onChange={event => update('displayName', event.target.value)} required/>
            {fieldError('displayName')}
          </label>
          <label className="auth-label" htmlFor="register-username">Username
            <input {...accessibility('username')} className="auth-input" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="pranshu45" maxLength={30} value={form.username} onChange={event => update('username', event.target.value)} required/>
            <span id="username-hint" className="mt-2 block text-xs font-normal text-[var(--text-muted)]">Your unique handle, e.g. pranshu45.</span>
            {fieldError('username')}
          </label>
        </div>
        <label className="auth-label" htmlFor="register-email">Email address
          <input {...accessibility('email')} className="auth-input" type="email" autoComplete="email" maxLength={254} placeholder="you@example.com" value={form.email} onChange={event => update('email', event.target.value)} required/>
          {fieldError('email')}
        </label>
        <label className="auth-label" htmlFor="register-password">Password
          <input {...accessibility('password')} className="auth-input" type="password" aria-label="Password" autoComplete="new-password" minLength={10} maxLength={72} value={form.password} onChange={event => update('password', event.target.value)} required/>
          <span id="password-hint" className="mt-2 block text-xs font-normal text-[var(--text-muted)]">Use at least 10 characters. A memorable passphrase works well.</span>
          {fieldError('password')}
        </label>
        <button disabled={saving} className="auth-submit">{saving ? 'Please wait…' : 'Create your account'}</button>
      </form>
    </>}
  </AuthLayout>;
}
