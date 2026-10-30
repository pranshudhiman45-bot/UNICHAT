import { useEffect, useRef, useState, type FormEvent } from 'react';
import axios from 'axios';
import { useAuth, type ProfileChanges } from '../../hooks/useAuth';
import Avatar from '../common/Avatar';
import Modal from '../common/Modal';

const fieldClass = 'mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]';

export default function EditProfileDialog({ onClose }: { onClose: () => void }) {
  const { user, updateProfile, uploadAvatar, removeAvatar } = useAuth();
  const [fields, setFields] = useState<ProfileChanges>(() => ({
    displayName: user?.displayName || '', title: user?.title || '', bio: user?.bio || '',
    statusMessage: user?.statusMessage || '', timezone: user?.timezone || 'UTC',
  }));
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => { if (previewRef.current) URL.revokeObjectURL(previewRef.current); }, []);

  const change = (key: keyof ProfileChanges, value: string) => setFields((current) => ({ ...current, [key]: value }));
  const choosePhoto = (selected?: File) => {
    if (!selected) return;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(selected.type)) { setError('Choose a JPEG, PNG, WebP or GIF image.'); return; }
    if (selected.size > 5 * 1024 * 1024) { setError('Profile photo must be 5 MB or smaller.'); return; }
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    const url = URL.createObjectURL(selected);
    previewRef.current = url;
    setPreview(url);
    setFile(selected);
    setError('');
  };
  const removePhoto = async () => {
    if (file) {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = null; setPreview(null); setFile(null);
      return;
    }
    setBusy(true); setError('');
    try { await removeAvatar(); }
    catch (cause) { setError(axios.isAxiosError(cause) ? cause.response?.data?.error || 'Unable to remove photo.' : 'Unable to remove photo.'); }
    finally { setBusy(false); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!fields.displayName.trim()) { setError('Display name is required.'); return; }
    setBusy(true); setError('');
    try {
      await updateProfile(fields);
    } catch (cause) {
      setError(axios.isAxiosError(cause) ? cause.response?.data?.error || 'Unable to save profile.' : 'Unable to save profile.');
      setBusy(false);
      return;
    }
    try {
      if (file) await uploadAvatar(file);
      onClose();
    } catch (cause) {
      const reason = axios.isAxiosError(cause) ? cause.response?.data?.error || 'Photo upload failed.' : 'Photo upload failed.';
      setError(`Profile details were saved, but the photo was not uploaded: ${reason}`);
    } finally { setBusy(false); }
  };

  if (!user) return null;
  return <Modal title="Edit profile" onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={(event) => void save(event)} className="max-h-[min(75vh,650px)] space-y-4 overflow-y-auto pr-1">
      <div className="flex items-center gap-4">
        {preview ? <img src={preview} alt="New profile photo preview" className="h-16 w-16 rounded-full object-cover" /> : <Avatar user={user} size="xl" />}
        <div className="space-y-1">
          <label className="inline-flex cursor-pointer rounded-md border border-[var(--border)] bg-[var(--bg-surface-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--text)] hover:border-[var(--accent)]">Choose photo<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="sr-only" disabled={busy} onChange={(event) => { choosePhoto(event.target.files?.[0]); event.target.value = ''; }} /></label>
          {(user.avatar || file) && <button type="button" disabled={busy} onClick={() => void removePhoto()} className="ml-2 text-xs text-[var(--text-secondary)] underline hover:text-[var(--text)]">{file ? 'Cancel selection' : 'Remove photo'}</button>}
          <p className="text-[11px] text-[var(--text-muted)]">JPEG, PNG, WebP or GIF · up to 5 MB</p>
        </div>
      </div>
      <label className="block text-xs font-medium">Display name<input className={fieldClass} required maxLength={50} value={fields.displayName} onChange={(event) => change('displayName', event.target.value)} /></label>
      <label className="block text-xs font-medium">Job title<input className={fieldClass} maxLength={80} value={fields.title} onChange={(event) => change('title', event.target.value)} placeholder="What do you do?" /></label>
      <label className="block text-xs font-medium">About me<textarea className={fieldClass} rows={3} maxLength={200} value={fields.bio} onChange={(event) => change('bio', event.target.value)} placeholder="A short introduction" /></label>
      <label className="block text-xs font-medium">Status message<input className={fieldClass} maxLength={100} value={fields.statusMessage} onChange={(event) => change('statusMessage', event.target.value)} placeholder="What are you working on?" /></label>
      <label className="block text-xs font-medium">Time zone<input className={fieldClass} maxLength={80} value={fields.timezone} onChange={(event) => change('timezone', event.target.value)} placeholder="e.g. Asia/Kolkata" /><span className="mt-1 block text-[11px] font-normal text-[var(--text-muted)]">Use an IANA time zone such as Asia/Kolkata or UTC.</span></label>
      <p className="text-[11px] text-[var(--text-muted)]">Username and email cannot be changed here.</p>
      {error && <p role="alert" className="rounded-md border border-[var(--error-border)] bg-[var(--error-surface)] px-3 py-2 text-xs text-[var(--error)]">{error}</p>}
      <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-4"><button type="button" disabled={busy} onClick={onClose} className="ui-secondary-button px-3 py-2 text-sm font-semibold disabled:opacity-60">Cancel</button><button type="submit" disabled={busy} className="ui-primary-button px-4 py-2 text-sm font-semibold disabled:cursor-wait">{busy ? 'Saving…' : 'Save changes'}</button></div>
    </form>
  </Modal>;
}
