import { useEffect, useRef } from 'react';
import { api } from './useAuth';
import { getSocket } from '../services/socket';

// Reading requires visible message content in a focused tab, not just room membership.
export function useMessageReadReceipts(workspaceId: string) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const visible = new Set<string>();
    const acknowledged = new Set<string>();
    const revisions = new Map<string, number>();
    const nodes = new Set<Element>();
    let sending = false;
    let stopped = false;
    let timer: number | undefined;
    const reading = () => document.visibilityState === 'visible' && document.hasFocus() && !document.querySelector('[aria-modal="true"]');
    const flush = async () => {
      if (stopped || sending || !reading()) return;
      const messageIds = [...visible].filter(id => !acknowledged.has(id)).slice(0, 100);
      if (!messageIds.length) return;
      sending = true;
      const sent = new Map(messageIds.map(id => [id, revisions.get(id) || 0]));
      try { await api.post('/notifications/read-messages', { workspaceId, messageIds }); messageIds.forEach(id => { if (sent.get(id) === (revisions.get(id) || 0)) acknowledged.add(id); }); }
      catch { /* Keep unread locally and retry while the messages remain visible. */ }
      finally { sending = false; }
    };
    const schedule = () => { if (timer) window.clearTimeout(timer); timer = window.setTimeout(() => void flush(), 350); };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.messageId!;
        if (entry.isIntersecting && entry.intersectionRect.height >= Math.min(60, entry.boundingClientRect.height * 0.5)) visible.add(id);
        else visible.delete(id);
      }
      schedule();
    }, { root, threshold: [0, 0.1, 0.5, 1] });
    const scan = () => {
      for (const node of nodes) if (!root.contains(node)) { observer.unobserve(node); nodes.delete(node); visible.delete((node as HTMLElement).dataset.messageId!); }
      root.querySelectorAll('[data-message-id]').forEach(node => { if (!nodes.has(node)) { nodes.add(node); observer.observe(node); } });
    };
    const mutation = new MutationObserver(scan); mutation.observe(root, { childList: true, subtree: true }); scan();
    const focus = () => { acknowledged.clear(); visible.forEach(id => revisions.set(id, (revisions.get(id) || 0) + 1)); schedule(); };
    const onNotification = (notification: any) => {
      const id = typeof notification.message === 'string' ? notification.message : notification.message?._id;
      if (id) { revisions.set(id, (revisions.get(id) || 0) + 1); acknowledged.delete(id); schedule(); }
    };
    const socket = getSocket(); socket?.on('notification:new', onNotification);
    document.addEventListener('visibilitychange', focus); window.addEventListener('focus', focus);
    const retry = window.setInterval(() => void flush(), 1500);
    return () => { stopped = true; observer.disconnect(); mutation.disconnect(); window.clearInterval(retry); window.clearTimeout(timer); socket?.off('notification:new', onNotification); document.removeEventListener('visibilitychange', focus); window.removeEventListener('focus', focus); };
  }, [workspaceId]);
  return container;
}
