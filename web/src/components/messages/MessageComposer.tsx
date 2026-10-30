import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { Attachment, User } from '../../types';
import { api } from '../../hooks/useAuth';
import FloatingMenu from '../common/FloatingMenu';
import UiIcon from '../common/UiIcon';
import ReactionPicker from './ReactionPicker';
import RichTextEditor, { type RichTextValue } from './RichTextEditor';

const MAX_FILE_SIZE_MB = 25;
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const allowedMimeTypes = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime',
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

interface Props {
  placeholder: string;
  disabled?: boolean;
  typingText?: string;
  members?: User[];
  workspaceId: string;
  channelId?: string;
  dmId?: string;
  parentMessageId?: string;
  contextMemberIds?: string[];
  contextType?: 'channel' | 'dm';
  onSend: (content: string, attachments: Attachment[], formattedContent?: string) => Promise<void>;
  onTyping?: (typing: boolean) => void;
}

interface PendingAttachment {
  id: string;
  file: File;
  objectUrl: string;
  status: 'uploading' | 'uploaded' | 'failed';
  progress: number;
  error?: string;
  attachment?: Attachment;
}

interface MentionTriggerRequest {
  id: number;
  range: { from: number; to: number };
}

interface EmojiInsertRequest {
  id: number;
  range: { from: number; to: number };
  emoji: string;
}

function itemId() { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

const allAccept = 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx';
const mediaAccept = 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime';
const documentAccept = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx';

export default function MessageComposer({ placeholder, disabled, typingText, members = [], workspaceId, channelId, dmId, parentMessageId, contextMemberIds = [], contextType, onSend, onTyping }: Props) {
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [selected, setSelected] = useState<PendingAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [formattingOpen, setFormattingOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [mentionTriggerRequest, setMentionTriggerRequest] = useState<MentionTriggerRequest | null>(null);
  const [emojiInsertRequest, setEmojiInsertRequest] = useState<EmojiInsertRequest | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [editorValue, setEditorValue] = useState<RichTextValue>({ text: '', json: { type: 'doc', content: [{ type: 'paragraph' }] } });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentButtonRef = useRef<HTMLButtonElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const lastSelectionRef = useRef<{ from: number; to: number } | null>(null);
  const typingTimer = useRef<number | undefined>(undefined);
  const selectedRef = useRef<PendingAttachment[]>([]);
  const sentUploadIds = useRef(new Set<string>());
  const mentionTriggerId = useRef(0);
  const emojiInsertId = useRef(0);

  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => {
    setFormattingOpen(false);
    setEmojiOpen(false);
    setPlusOpen(false);
    setMoreOpen(false);
    setMentionTriggerRequest(null);
    setEmojiInsertRequest(null);
    lastSelectionRef.current = null;
  }, [channelId, dmId, parentMessageId, placeholder]);
  useEffect(() => () => {
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    onTyping?.(false);
    selectedRef.current.forEach((item) => URL.revokeObjectURL(item.objectUrl));
    void Promise.all(selectedRef.current.filter((item) => item.attachment?.uploadId && !sentUploadIds.current.has(item.attachment.uploadId)).map((item) => api.delete(`/files/${item.attachment?.uploadId}`).catch(() => undefined)));
  }, []);

  const uploadItem = async (item: PendingAttachment) => {
    const form = new FormData();
    // Conversation fields first: the server authorizes the upload before it accepts the file bytes.
    form.append('workspaceId', workspaceId);
    if (channelId) form.append('channelId', channelId);
    if (dmId) form.append('dmId', dmId);
    if (parentMessageId) form.append('parentMessageId', parentMessageId);
    form.append('files', item.file);
    try {
      const response = await api.post('/files/upload', form, { onUploadProgress: (event) => { const progress = event.total ? Math.round((event.loaded / event.total) * 100) : 0; setSelected((current) => current.map((entry) => entry.id === item.id ? { ...entry, progress } : entry)); } });
      const attachment = response.data.attachments?.[0] as Attachment | undefined;
      if (!attachment) throw new Error('Upload did not return an attachment');
      setSelected((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: 'uploaded', progress: 100, attachment } : entry));
    } catch (error: any) {
      setSelected((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: 'failed', error: error.response?.data?.error || 'Upload failed' } : entry));
    }
  };

  const addFiles = (files: File[]) => {
    if (disabled || sending) return;
    const remaining = MAX_ATTACHMENTS - selected.length;
    const nextFiles = files.slice(0, Math.max(0, remaining));
    const next = nextFiles.map((file) => {
      const base = { id: itemId(), file, objectUrl: URL.createObjectURL(file), status: 'uploading' as const, progress: 0 };
      if (!allowedMimeTypes.has(file.type)) return { ...base, status: 'failed' as const, error: 'This file type is not supported' };
      if (file.size > MAX_FILE_SIZE) return { ...base, status: 'failed' as const, error: `Maximum size is ${MAX_FILE_SIZE_MB} MB` };
      return base;
    });
    setSelected((current) => [...current, ...next]);
    next.filter((item) => item.status === 'uploading').forEach((item) => void uploadItem(item));
    if (files.length > nextFiles.length) setSendError(`You can attach up to ${MAX_ATTACHMENTS} files`);
  };

  const openPicker = (accept: string) => { if (fileInputRef.current) { fileInputRef.current.accept = accept; fileInputRef.current.click(); } setPlusOpen(false); };
  const removeFile = (item: PendingAttachment) => { URL.revokeObjectURL(item.objectUrl); if (item.attachment?.uploadId) void api.delete(`/files/${item.attachment.uploadId}`).catch(() => undefined); setSelected((current) => current.filter((entry) => entry.id !== item.id)); };
  const retryFile = (item: PendingAttachment) => { const retry = { ...item, status: 'uploading' as const, progress: 0, error: undefined }; setSelected((current) => current.map((entry) => entry.id === item.id ? retry : entry)); void uploadItem(retry); };

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const content = editorValue.text.trim();
    const uploaded = selected.filter((item) => item.status === 'uploaded' && item.attachment).map((item) => item.attachment as Attachment);
    if ((!content && !uploaded.length) || disabled || sending) return;
    if (selected.some((item) => item.status === 'uploading')) { setSendError('Wait for attachments to finish uploading'); return; }
    if (selected.some((item) => item.status === 'failed')) { setSendError('Remove or retry failed attachments before sending'); return; }
    setSending(true); setSendError(''); onTyping?.(false);
    try {
      await onSend(content, uploaded, JSON.stringify(editorValue.json));
      uploaded.forEach((attachment) => { if (attachment.uploadId) sentUploadIds.current.add(attachment.uploadId); });
      selected.forEach((item) => URL.revokeObjectURL(item.objectUrl));
      setSelected([]); setEditorValue({ text: '', json: { type: 'doc', content: [{ type: 'paragraph' }] } }); setEditorKey((key) => key + 1); setFormattingOpen(false); setPlusOpen(false); setMoreOpen(false); setEmojiOpen(false); setMentionTriggerRequest(null); setEmojiInsertRequest(null);
    } catch (error) { setSendError(error instanceof Error ? error.message : 'Unable to send message'); }
    finally { setSending(false); }
  };

  const closeMenus = () => { setFormattingOpen(false); setPlusOpen(false); setMoreOpen(false); setEmojiOpen(false); };
  const toggleAttachmentMenu = () => setPlusOpen((open) => { if (!open) { setFormattingOpen(false); setEmojiOpen(false); setMoreOpen(false); } return !open; });
  const toggleFormatting = () => setFormattingOpen((open) => { if (!open) { setPlusOpen(false); setEmojiOpen(false); setMoreOpen(false); } return !open; });
  const saveEditorSelection = () => {
    const editor = editorRef.current;
    if (editor) lastSelectionRef.current = { from: editor.state.selection.from, to: editor.state.selection.to };
  };
  const toggleEmoji = () => setEmojiOpen((open) => { if (!open) { saveEditorSelection(); setFormattingOpen(false); setPlusOpen(false); setMoreOpen(false); } return !open; });
  const toggleMoreMenu = () => setMoreOpen((open) => { if (!open) { setFormattingOpen(false); setPlusOpen(false); setEmojiOpen(false); } return !open; });
  const insertEmoji = (emoji: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const range = lastSelectionRef.current || {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    };
    setEmojiInsertRequest({ id: ++emojiInsertId.current, range, emoji });
    setEmojiOpen(false);
  };
  const triggerMention = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const range = lastSelectionRef.current || {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    };
    closeMenus();
    setMentionTriggerRequest({ id: ++mentionTriggerId.current, range });
    lastSelectionRef.current = null;
  };

  return <form onSubmit={(event) => void submit(event)} onPaste={(event) => { const pastedImage = Array.from(event.clipboardData.items).find((item) => item.type.startsWith('image/')); const file = pastedImage?.getAsFile(); if (file) { event.preventDefault(); addFiles([new File([file], `pasted-image-${Date.now()}.${file.type.split('/')[1] || 'png'}`, { type: file.type })]); } }} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)); }} className="message-composer relative border-t border-[var(--border)] bg-[var(--background)] px-6 py-3">
    {dragging && <div className="composer-drop-overlay absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-[var(--accent)] text-sm font-semibold text-[var(--accent)]">Drop files to upload</div>}
    <input ref={fileInputRef} type="file" multiple accept={allAccept} className="hidden" onChange={(event) => { addFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
    <div aria-live="polite" className="min-h-5 pb-1 text-[11px] text-slate-400">{typingText || '\u00a0'}</div>
    {selected.length > 0 && <div className="mb-2 flex flex-wrap gap-2" aria-label="Pending attachments">{selected.map((item) => <div key={item.id} className="flex max-w-full items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5">{item.file.type.startsWith('image/') && <img src={item.objectUrl} alt="" className="h-8 w-8 object-cover" />}{item.file.type.startsWith('video/') && <video src={item.objectUrl} muted className="h-8 w-8 object-cover" />}{!item.file.type.startsWith('image/') && !item.file.type.startsWith('video/') && <span className="flex h-8 w-8 items-center justify-center bg-white text-[10px] font-bold uppercase text-[var(--accent)]">DOC</span>}<span className="max-w-48 truncate text-[11px] text-slate-700" title={item.file.name}>{item.file.name}</span>{item.status === 'uploading' && <span className="text-[10px] text-slate-400">{item.progress}%</span>}{item.status === 'failed' && <button type="button" onClick={() => retryFile(item)} className="text-[10px] font-semibold text-[var(--error)] underline">Retry</button>}{item.status === 'uploaded' && <span className="text-[10px] text-emerald-600">Ready</span>}{item.error && <span className="max-w-32 truncate text-[10px] text-[var(--error)]" title={item.error}>{item.error}</span>}<button type="button" onClick={() => removeFile(item)} className="text-sm text-slate-400 hover:text-slate-700" aria-label={`Remove ${item.file.name}`}>X</button></div>)}</div>}
    <div className="composer-surface">
      <div className="border-b border-[var(--composer-border)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)]">{placeholder}</div>
      <RichTextEditor key={editorKey} placeholder="Write a message…" disabled={disabled || sending} members={members} contextMemberIds={contextMemberIds} contextType={contextType} toolbarOpen={formattingOpen} mentionTriggerRequest={mentionTriggerRequest} emojiInsertRequest={emojiInsertRequest} onEditorReady={(editor) => { editorRef.current = editor; }} onChange={(next) => { setEditorValue(next); setSendError(''); }} onSubmit={() => void submit()} onTyping={(typing) => { onTyping?.(typing); if (typing) { if (typingTimer.current) window.clearTimeout(typingTimer.current); typingTimer.current = window.setTimeout(() => onTyping?.(false), 1200); } }} />
      <div className="composer-toolbar flex items-center justify-between border-t border-slate-100 px-2 py-1.5">
        <div className="flex items-center gap-0.5">
          <button ref={attachmentButtonRef} type="button" disabled={disabled || sending} onClick={toggleAttachmentMenu} className="flex h-[30px] w-[30px] items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-surface-secondary)] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-surface-secondary)] hover:text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-40" aria-label="Add attachment" title="Add attachment"><svg aria-hidden="true" viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M10 4.5v11M4.5 10h11" /></svg></button>
          <FloatingMenu anchorRef={attachmentButtonRef} open={plusOpen} onClose={() => setPlusOpen(false)} className="composer-attachment-menu" fallbackWidth={240} fallbackHeight={132} ariaLabel="Attachment options">
            <button type="button" onClick={() => openPicker(allAccept)} className="composer-popup-item"><span className="composer-popup-icon" aria-hidden="true">+</span>Upload file</button>
            <button type="button" onClick={() => openPicker(mediaAccept)} className="composer-popup-item"><span className="composer-popup-icon" aria-hidden="true">IMG</span>Upload image/video</button>
            <button type="button" onClick={() => openPicker(documentAccept)} className="composer-popup-item"><span className="composer-popup-icon" aria-hidden="true">DOC</span>Upload document</button>
          </FloatingMenu>
          <button type="button" disabled={disabled || sending} onClick={toggleFormatting} className={`h-7 px-2 text-xs font-semibold ${formattingOpen ? 'bg-indigo-50 text-[var(--accent)]' : 'text-slate-500 hover:text-[var(--accent)]'}`} aria-label="Toggle formatting" title="Formatting">Aa</button>
          <div className="relative"><button ref={emojiButtonRef} type="button" disabled={disabled || sending} onMouseDown={(event) => { event.preventDefault(); saveEditorSelection(); }} onClick={toggleEmoji} className="h-7 px-2 text-xs text-slate-500 hover:text-[var(--accent)] disabled:opacity-40" aria-label="Insert emoji" title="Insert emoji">Emoji</button>{emojiOpen && <ReactionPicker anchorRef={emojiButtonRef} className="composer-emoji-picker" onSelect={insertEmoji} onClose={() => setEmojiOpen(false)} />}</div>
          <button type="button" disabled={disabled || sending} onMouseDown={(event) => { event.preventDefault(); saveEditorSelection(); }} onClick={triggerMention} className="h-7 px-2 text-sm text-slate-500 hover:text-[var(--accent)] disabled:opacity-40" aria-label="Mention someone" title="Mention someone">@</button>
          <button ref={moreButtonRef} type="button" disabled={disabled || sending} onClick={toggleMoreMenu} className="h-7 px-2 text-lg leading-none text-slate-500 hover:text-[var(--accent)] disabled:opacity-40" aria-label="More composer actions" title="More actions">…</button>
          <FloatingMenu anchorRef={moreButtonRef} open={moreOpen} onClose={() => setMoreOpen(false)} className="composer-more-menu" fallbackWidth={190} fallbackHeight={92} ariaLabel="More composer actions">
            <button type="button" onClick={() => { editorRef.current?.chain().focus().toggleCodeBlock().run(); setMoreOpen(false); }} className="composer-popup-item">Toggle code block</button>
            <button type="button" onClick={() => { editorRef.current?.chain().focus().clearNodes().unsetAllMarks().run(); setMoreOpen(false); }} className="composer-popup-item">Clear formatting</button>
          </FloatingMenu>
        </div>
        <div className="flex items-center gap-1"><button type="submit" disabled={disabled || sending || (!editorValue.text.trim() && !selected.some((item) => item.status === 'uploaded'))} className="composer-send-button flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-semibold">{sending ? 'Sending…' : 'Send'}<UiIcon name="send" size={14} /></button></div>
      </div>
      <p className="composer-helper px-3 pb-2 text-[10px]">Shift + Enter to add a new line</p>{sendError && <p className="border-t border-red-100 bg-red-50 px-3 py-1.5 text-[11px] text-[var(--error)]" role="alert">{sendError}</p>}
    </div>
  </form>;
}
