import { useState } from 'react';
import type { Attachment } from '../../types';
import Modal from '../common/Modal';
import { useAttachmentUrls } from '../../services/attachmentUrls';

function formatBytes(size?: number) { if (!size) return 'Unknown size'; if (size < 1024) return `${size} B`; if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`; return `${(size / (1024 * 1024)).toFixed(1)} MB`; }
function fileLabel(attachment: Attachment) { return attachment.name || attachment.mimeType?.split('/').pop()?.toUpperCase() || 'Attachment'; }

export default function AttachmentDisplay({ attachments = [] }: { attachments?: Attachment[] }) {
  const [viewer, setViewer] = useState<Attachment | null>(null);
  const urlOf = useAttachmentUrls(attachments);
  if (!attachments.length) return null;
  return <>
    <div className="mt-2 flex flex-wrap gap-2" aria-label="Message attachments">{attachments.map((attachment, index) => attachment.type === 'image' || attachment.type === 'video' ? <button key={attachment.uploadId || attachment.publicId || `${attachment.name}-${index}`} type="button" onClick={() => setViewer(attachment)} className="group block max-w-[min(28rem,100%)] overflow-hidden border border-slate-200 bg-slate-50 text-left" aria-label={`Open ${fileLabel(attachment)}`}>{attachment.type === 'image' ? <img src={urlOf(attachment) || undefined} alt={fileLabel(attachment)} className="max-h-72 max-w-full object-contain" loading="lazy" /> : <video src={urlOf(attachment) || undefined} controls className="max-h-72 max-w-full" />}{<span className="block truncate px-2 py-1 text-[10px] text-slate-500 group-hover:text-[var(--accent)]">{fileLabel(attachment)}</span>}</button> : <div key={attachment.uploadId || attachment.publicId || `${attachment.name}-${index}`} className="flex min-w-[220px] max-w-full items-center gap-3 border border-slate-200 bg-slate-50 px-3 py-2"><span className="flex h-9 w-9 shrink-0 items-center justify-center bg-white text-[10px] font-bold uppercase text-[var(--accent)]">{attachment.mimeType?.includes('pdf') ? 'PDF' : 'DOC'}</span><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-slate-700" title={fileLabel(attachment)}>{fileLabel(attachment)}</p><p className="text-[10px] text-slate-400">{formatBytes(attachment.size)}</p></div><span className="flex shrink-0 gap-2 text-[10px] font-semibold"><a href={urlOf(attachment)} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">Open</a><a href={urlOf(attachment)} download={attachment.name || true} target="_blank" rel="noreferrer" className="text-slate-500 hover:underline">Download</a></span></div>)}</div>
    {viewer && <Modal title={fileLabel(viewer)} onClose={() => setViewer(null)}>{viewer.type === 'video' ? <video src={urlOf(viewer) || undefined} controls autoPlay className="max-h-[70vh] max-w-full" /> : <img src={urlOf(viewer) || undefined} alt={fileLabel(viewer)} className="max-h-[70vh] max-w-full object-contain" />}<div className="mt-3 flex justify-end gap-3 text-xs font-semibold"><a href={urlOf(viewer)} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">Open original</a><a href={urlOf(viewer)} download={viewer.name || true} target="_blank" rel="noreferrer" className="text-slate-500 hover:underline">Download</a></div></Modal>}
  </>;
}
