import { useEffect, useMemo, useState } from 'react';
import { api } from '../hooks/useAuth';
import type { Attachment } from '../types';

// Attachment URLs are short-lived, per-user and never broadcast over sockets. This module resolves
// them on demand, caches them until shortly before expiry, and keeps visible ones fresh so that
// "Open original" works however long the chat has been open.
interface Entry { url: string; expiresAt: number }
const REFRESH_BEFORE_MS = 60_000;
const cache = new Map<string, Entry>();
let queue = new Map<string, Array<(entry: Entry | null) => void>>();
let timer: number | undefined;

function usable(entry: Entry | undefined, margin = REFRESH_BEFORE_MS): entry is Entry {
  return Boolean(entry && entry.expiresAt - margin > Date.now());
}

function flush() {
  const batch = queue; queue = new Map(); timer = undefined;
  const ids = [...batch.keys()];
  const settle = (id: string, entry: Entry | null) => batch.get(id)?.forEach((resolve) => resolve(entry));
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  chunks.forEach((chunk) => {
    api.post('/files/urls', { uploadIds: chunk })
      .then((response) => {
        const urls = (response.data.urls || {}) as Record<string, Entry>;
        chunk.forEach((id) => { const entry = urls[id]; if (entry) cache.set(id, entry); else cache.delete(id); settle(id, entry || null); });
      })
      .catch(() => chunk.forEach((id) => settle(id, null)));
  });
}

export function resolveAttachmentUrl(uploadId: string, force = false): Promise<Entry | null> {
  const cached = cache.get(uploadId);
  if (!force && usable(cached)) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const waiting = queue.get(uploadId) || [];
    waiting.push(resolve); queue.set(uploadId, waiting);
    if (timer === undefined) timer = window.setTimeout(flush, 20);
  });
}

function seed(attachment: Attachment) {
  const issued = attachment as Attachment & { urlExpiresAt?: number };
  if (attachment.uploadId && attachment.url && issued.urlExpiresAt && !cache.has(attachment.uploadId)) {
    cache.set(attachment.uploadId, { url: attachment.url, expiresAt: issued.urlExpiresAt });
  }
}

/** Returns a function giving the currently valid URL for each attachment ('' while loading or denied). */
export function useAttachmentUrls(attachments: Attachment[] = []): (attachment: Attachment) => string {
  const [, rerender] = useState(0);
  const ids = useMemo(() => attachments.filter((a) => a.uploadId && a.accessMode === 'authenticated').map((a) => a.uploadId as string), [attachments]);
  const key = ids.join(',');
  attachments.forEach(seed);

  useEffect(() => {
    if (!ids.length) return undefined;
    let cancelled = false; let timeout: number | undefined;
    const refresh = async () => {
      await Promise.all(ids.map((id) => resolveAttachmentUrl(id)));
      if (cancelled) return;
      rerender((n) => n + 1);
      const soonest = Math.min(...ids.map((id) => cache.get(id)?.expiresAt ?? Date.now() + 30_000));
      timeout = window.setTimeout(() => void refresh(), Math.max(5_000, soonest - REFRESH_BEFORE_MS - Date.now()));
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => { cancelled = true; window.clearTimeout(timeout); document.removeEventListener('visibilitychange', onVisible); };
  }, [key]);

  return (attachment) => {
    if (!attachment.uploadId || attachment.accessMode !== 'authenticated') return attachment.url;
    const entry = cache.get(attachment.uploadId);
    return entry && entry.expiresAt > Date.now() ? entry.url : '';
  };
}

export function clearAttachmentUrlCache() { cache.clear(); }
