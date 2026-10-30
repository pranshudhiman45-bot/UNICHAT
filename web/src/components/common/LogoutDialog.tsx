import { useState } from 'react';
import Modal from './Modal';

export default function LogoutDialog({ onClose, onLogout }: { onClose: () => void; onLogout: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const confirm = async () => {
    setBusy(true); setError('');
    try { await onLogout(); }
    catch { setBusy(false); setError('Could not log out. Please try again.'); }
  };
  return <Modal title="Log out of Unichat?" onClose={() => { if (!busy) onClose(); }}>
    <p className="text-sm text-[var(--text-secondary)]">You can sign in again at any time.</p>
    {error && <p className="mt-3 text-xs text-[var(--error)]" role="alert">{error}</p>}
    <div className="mt-5 flex justify-end gap-2">
      <button type="button" disabled={busy} onClick={onClose} className="rounded-md border border-[var(--border)] px-4 py-2 text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--bg-surface-secondary)] disabled:opacity-50">Cancel</button>
      <button type="button" disabled={busy} onClick={() => void confirm()} className="rounded-md bg-[var(--error)] px-4 py-2 text-xs font-semibold text-white hover:brightness-90 disabled:opacity-50">{busy ? 'Logging out…' : 'Log out'}</button>
    </div>
  </Modal>;
}
