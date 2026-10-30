import { useCallback, useEffect, useRef, useState } from 'react';
import type { Channel, DirectMessage, NotificationItem, User } from '../../types';
import { api } from '../../hooks/useAuth';
import { getSocket } from '../../services/socket';
import Avatar from '../common/Avatar';
import { getDisplayText, getUserDisplayName } from '../../utils/userDisplay';

type Filter = 'all' | 'mentions' | 'threads' | 'reactions' | 'invitations';
type View = 'unread' | 'all' | 'cleared';
interface Props {
  workspaceId: string; workspaceName: string; channels: Channel[]; dms: DirectMessage[]; members: User[];
  onClose: () => void; onOpen: (notification: NotificationItem) => void;
}
const filters: { id: Filter; label: string }[] = [{ id: 'all', label: 'Everything' }, { id: 'mentions', label: 'Mentions' }, { id: 'threads', label: 'Threads' }, { id: 'reactions', label: 'Reactions' }, { id: 'invitations', label: 'Invitations' }];
function actionText(item: NotificationItem) {
  const actor = getUserDisplayName(item.actor);
  if (item.type === 'workspace_join_request') return `${actor} wants to join your workspace`;
  if (item.type === 'workspace_join_approved') return `${actor} accepted your request to join the workspace`;
  if (item.type === 'mention') return `${actor} mentioned you`;
  if (item.type === 'thread_reply') return `${actor} replied to your thread`;
  if (item.type === 'reaction') return `${actor} reacted ${item.metadata?.emoji || ''} to your message`;
  if (item.type === 'channel_invite') return `${actor} invited you to #${item.channel?.name || 'a channel'}`;
  return item.content || `${actor} invited you to collaborate`;
}
export default function ActivityCenter({ workspaceId, workspaceName, members, onClose, onOpen }: Props) {
  const [view, setView] = useState<View>('unread');
  const [filter, setFilter] = useState<Filter>('all');
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const version = useRef(0);
  const load = useCallback(async (next?: string, quiet = false) => {
    const request = ++version.current;
    if (next) setLoadingMore(true); else if (!quiet) setLoading(true);
    try {
      const query = new URLSearchParams({ workspaceId, scope: 'activity', filter, unreadOnly: String(view === 'unread'), cleared: String(view === 'cleared'), limit: '30' });
      if (next) query.set('cursor', next);
      const { data } = await api.get('/notifications?' + query);
      if (request !== version.current) return;
      setItems(current => next ? [...current, ...data.notifications.filter((item: NotificationItem) => !current.some(existing => existing._id === item._id))] : data.notifications);
      setCursor(data.nextCursor); setUnreadCount(data.unreadCount); setError('');
      window.dispatchEvent(new CustomEvent('unichat:activity-count', { detail: { count: data.unreadCount } }));
    } catch (e: any) { if (request === version.current) setError(e.response?.data?.error || 'Unable to load activity.'); }
    finally { if (request === version.current) { setLoading(false); setLoadingMore(false); } }
  }, [workspaceId, filter, view]);
  useEffect(() => {
    void load();
    const socket = getSocket(); let timer: number | undefined;
    const refresh = (event: any) => {
      const eventWorkspace = event?.workspaceId || event?.workspace?._id || event?.workspace;
      if (eventWorkspace && eventWorkspace !== workspaceId) return;
      window.clearTimeout(timer); timer = window.setTimeout(() => void load(undefined, true), 120);
    };
    const events = ['notification:new', 'notification:read', 'notification:read_all', 'activity:changed'];
    events.forEach(event => socket?.on(event, refresh));
    const focus = () => void load(undefined, true); window.addEventListener('focus', focus);
    return () => { version.current++; window.clearTimeout(timer); events.forEach(event => socket?.off(event, refresh)); window.removeEventListener('focus', focus); };
  }, [load, workspaceId]);
  const action = async (item: NotificationItem, name: 'read' | 'unread' | 'clear') => {
    setBusy(true); setError('');
    try { await api.patch(`/notifications/${item._id}/${name}`); await load(undefined, true); }
    catch (e: any) { setError(e.response?.data?.error || 'Unable to update activity.'); }
    finally { setBusy(false); }
  };
  return <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-3 pt-14 sm:px-4" role="dialog" aria-modal="true" aria-label="Activity center">
    <section className="flex max-h-[calc(100dvh-80px)] w-full max-w-[680px] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-xl">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4"><div><h2 className="text-xl font-semibold">Activity</h2><p className="mt-1 text-xs text-[var(--text-secondary)]">Mentions, replies, reactions and invitations · {workspaceName}</p></div><button type="button" className="rounded-md p-2 text-xl text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]" onClick={onClose} aria-label="Close activity">×</button></header>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3"><nav aria-label="Activity views" className="flex gap-1">{(['unread', 'all', 'cleared'] as View[]).map(value => <button key={value} aria-pressed={view === value} onClick={() => setView(value)} className={`rounded-md px-3 py-1.5 text-sm font-semibold ${view === value ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}>{value === 'unread' ? `Unread${unreadCount ? ` (${unreadCount})` : ''}` : value === 'all' ? 'All' : 'Cleared'}</button>)}</nav>{unreadCount > 0 && <button disabled={busy} className="text-xs font-semibold text-[var(--accent)]" onClick={async () => { setBusy(true); try { await api.post('/notifications/read-all', { workspaceId, scope: 'activity' }); await load(undefined, true); } catch { setError('Unable to mark activity read.'); } finally { setBusy(false); } }}>Mark all read</button>}</div>
      <nav className="flex gap-1 overflow-x-auto border-b border-[var(--border)] px-4 py-2" aria-label="Activity filters">{filters.map(entry => <button key={entry.id} aria-pressed={filter === entry.id} onClick={() => setFilter(entry.id)} className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs ${filter === entry.id ? 'bg-[var(--bg-surface-secondary)] font-semibold text-[var(--text)]' : 'text-[var(--text-secondary)]'}`}>{entry.label}</button>)}</nav>
      <div className="min-h-0 overflow-y-auto">
        {error && <p role="alert" className="p-4 text-sm text-red-600">{error} <button onClick={() => void load()} className="underline">Retry</button></p>}
        {loading ? <p role="status" className="p-10 text-center text-sm text-[var(--text-muted)]">Loading activity…</p> : !items.length ? <div className="px-6 py-14 text-center"><h3 className="font-semibold">{view === 'unread' ? 'You’re all caught up' : view === 'cleared' ? 'No cleared activity' : 'No activity yet'}</h3><p className="mt-2 text-sm text-[var(--text-secondary)]">{view === 'unread' ? 'Reading a message clears its unread activity. Find read items in All.' : 'Routine messages stay in your channels and DMs.'}</p></div> : items.map(item => {
          const isUnread = !item.isRead && !item.readAt;
          return <article key={item._id} className={`activity-row flex gap-3 border-b border-[var(--border)] px-4 py-4 ${isUnread ? 'bg-[var(--accent-soft)]' : ''}`}>
            <button className="flex min-w-0 flex-1 gap-3 text-left" aria-label={`Open activity: ${actionText(item)}`} onClick={() => { if (isUnread) void api.patch(`/notifications/${item._id}/read`).catch(() => undefined); onOpen(item); }}><Avatar user={item.actor} size="sm" showPresence/><span className="min-w-0"><span className="block text-sm font-semibold">{actionText(item)}{isUnread && <span aria-label="Unread" className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />}</span><span className="mt-1 block line-clamp-2 break-words text-xs text-[var(--text-secondary)]">{getDisplayText(item.metadata?.preview || item.message?.content || item.content, members)}</span><span className="mt-2 block text-[11px] text-[var(--text-muted)]">{item.channel?.name ? `#${item.channel.name} · ` : ''}{new Date(item.createdAt).toLocaleString()}</span></span></button>
            <div className="flex shrink-0 flex-col items-end gap-2 text-xs"><button disabled={busy} onClick={() => void action(item, isUnread ? 'read' : 'unread')} className="text-[var(--accent)]">{isUnread ? 'Mark read' : view === 'cleared' ? 'Restore unread' : 'Mark unread'}</button>{view !== 'cleared' && <button disabled={busy} aria-label={`Clear activity: ${actionText(item)}`} onClick={() => void action(item, 'clear')} className="text-[var(--text-secondary)]">Clear</button>}</div>
          </article>;
        })}
        {!loading && cursor && <div className="p-4 text-center"><button disabled={loadingMore} onClick={() => void load(cursor)} className="text-sm text-[var(--accent)]">{loadingMore ? 'Loading…' : 'Load more'}</button></div>}
      </div>
    </section>
  </div>;
}
