import { useState } from 'react';
import Modal from '../common/Modal';

export default function CreateChannelModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, description: string, type: 'public' | 'private') => Promise<void> }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<'public' | 'private'>('public');
  const [saving, setSaving] = useState(false);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); if (!name.trim()) return; setSaving(true); try { await onCreate(name.trim(), description.trim(), type); } finally { setSaving(false); } };
  return <Modal title="Create channel" onClose={onClose}><form onSubmit={submit} className="space-y-3"><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Channel name" className="w-full border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--accent)]" /><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description (optional)" className="w-full border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--accent)]" /><select value={type} onChange={(event) => setType(event.target.value as 'public' | 'private')} className="w-full border border-slate-300 px-3 py-2 text-sm"><option value="public">Public — workspace members can discover it</option><option value="private">Private — invited members only</option></select><div className="flex justify-end gap-2 pt-2"><button type="button" onClick={onClose} className="border border-slate-200 px-4 py-2 text-xs text-slate-600">Cancel</button><button disabled={saving} className="bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">{saving ? 'Creating…' : 'Create'}</button></div></form></Modal>;
}
