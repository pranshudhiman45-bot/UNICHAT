import { useRef, useState } from 'react';
import RichTextEditor from './RichTextEditor';

interface Props {
  initialValue: string;
  initialFormattedContent?: string;
  saving?: boolean;
  error?: string;
  members?: import('../../types').User[];
  contextMemberIds?: string[];
  contextType?: 'channel' | 'dm';
  onSave: (content: string, formattedContent?: string) => Promise<void>;
  onCancel: () => void;
}

export default function MessageEditForm({ initialValue, initialFormattedContent, saving = false, error, members = [], contextMemberIds = [], contextType, onSave, onCancel }: Props) {
  const initialEditorContent = initialFormattedContent || JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: initialValue ? [{ type: 'text', text: initialValue }] : [] }] });
  let initialJson: any;
  try { initialJson = initialFormattedContent ? JSON.parse(initialFormattedContent) : undefined; } catch { initialJson = undefined; }
  const valueRef = useRef({ text: initialValue, json: initialJson });
  const [hasContent, setHasContent] = useState(Boolean(initialValue.trim()));
  const submit = async () => { const content = valueRef.current.text.trim(); if (!content) return; await onSave(content, valueRef.current.json ? JSON.stringify(valueRef.current.json) : undefined); };
  return <div className="max-w-2xl border border-[var(--accent)] bg-white shadow-sm">
    <RichTextEditor initialContent={initialEditorContent} placeholder="Edit message…" disabled={saving} members={members} contextMemberIds={contextMemberIds} contextType={contextType} toolbarOpen autoFocus onChange={(next) => { valueRef.current = next; setHasContent(Boolean(next.text.trim())); }} onSubmit={() => void submit()} onCancel={onCancel} />
    <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2"><div>{error && <p className="text-[11px] text-[var(--error)]" role="alert">{error}</p>}{!error && <p className="text-[10px] text-slate-400">Enter to save · Shift + Enter for a new line · Escape to cancel</p>}</div><div className="flex gap-2"><button type="button" disabled={saving} onClick={onCancel} className="border border-slate-200 px-3 py-1 text-[11px] text-slate-600">Cancel</button><button type="button" disabled={saving || !hasContent} onClick={() => void submit()} className="bg-[var(--accent)] px-3 py-1 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">{saving ? 'Saving…' : 'Save'}</button></div></div>
  </div>;
}
