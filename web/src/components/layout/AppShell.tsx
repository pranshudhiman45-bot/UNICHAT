import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Channel, DirectMessage, NotificationItem, PinnedMessage, SavedMessage, SearchResult, User, Workspace } from '../../types';
import { api } from '../../hooks/useAuth';
import TopBar from './TopBar';
import WorkspaceRail from './WorkspaceRail';
import WorkspaceSidebar from './WorkspaceSidebar';
import { useSidebarWidth } from '../../hooks/useSidebarWidth';

const ActivityCenter = lazy(() => import('../activity/ActivityCenter'));
const PinnedMessages = lazy(() => import('../pinned/PinnedMessages'));
const SavedMessages = lazy(() => import('../saved/SavedMessages'));
const SearchModal = lazy(() => import('../search/SearchModal'));

interface Props {
  user: User;
  workspace: Workspace;
  workspaces: Workspace[];
  channels: Channel[];
  dms: DirectMessage[];
  activeType: 'channel' | 'dm';
  activeId?: string;
  unreadChannels: Record<string, number>;
  unreadDMs: Record<string, number>;
  mentionChannels: Record<string, number>;
  mentionDMs: Record<string, number>;
  workspaceHasUnread: boolean;
  activityUnreadCount?: number;
  socketConnected: boolean;
  onWorkspace: (id: string) => void;
  onAddWorkspace: () => void;
  onChannel: (channel: Channel) => void;
  onDM: (dm: DirectMessage) => void;
  onCreateChannel: () => void;
  onNewMessage: () => void;
  onOpenMembers?: () => void;
  onLogout: () => Promise<void>;
  onSearch?: () => void;
  onSaved?: () => void;
  children: ReactNode;
}

function FeatureOverlays({ props }: { props: Props }) {
  const [activityOpen, setActivityOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [savedItems, setSavedItems] = useState<SavedMessage[]>([]);
  const [pinnedItems, setPinnedItems] = useState<PinnedMessage[]>([]);
  const [savedError, setSavedError] = useState('');
  const [pinnedError, setPinnedError] = useState('');
  const members = (props.workspace.members || []).map((member) => member.user);
  const activeChannelId = props.activeType === 'channel' ? props.activeId : undefined;
  const workspaceIdRef = useRef(props.workspace._id);
  const channelIdRef = useRef(activeChannelId);
  workspaceIdRef.current = props.workspace._id;
  channelIdRef.current = activeChannelId;

  const loadSaved = useCallback(async () => {
    try {
      const response = await api.get('/saved?workspaceId=' + props.workspace._id);
      if (workspaceIdRef.current !== props.workspace._id) return;
      const nextItems = response.data.saved as SavedMessage[];
      setSavedError('');
      setSavedItems(nextItems);
      window.dispatchEvent(new CustomEvent('unichat:saved-state', { detail: { ids: nextItems.map((item) => item.message?._id).filter(Boolean) } }));
    } catch (error) { if (workspaceIdRef.current === props.workspace._id) { setSavedItems([]); setSavedError('Unable to load saved messages.'); } throw error; }
  }, [props.workspace._id]);
  const loadPinned = useCallback(async () => {
    if (!activeChannelId) { setPinnedItems([]); return; }
    try {
      const response = await api.get('/channels/' + activeChannelId + '/pins');
      if (channelIdRef.current !== activeChannelId) return;
      setPinnedError('');
      setPinnedItems(response.data.pinnedMessages || []);
    } catch (error) { if (channelIdRef.current === activeChannelId) { setPinnedItems([]); setPinnedError('Unable to load pinned messages.'); } throw error; }
  }, [activeChannelId]);

  useEffect(() => { void loadSaved().catch(() => undefined); }, [loadSaved]);
  useEffect(() => {
    setActivityOpen(false); setSearchOpen(false); setSavedOpen(false); setPinnedOpen(false);
    setSavedItems([]); setPinnedItems([]);
    setSavedError(''); setPinnedError('');
  }, [props.workspace._id]);
  useEffect(() => {
    const onActivity = () => setActivityOpen(true);
    const onSearch = () => setSearchOpen(true);
    const onSaved = () => { void loadSaved().then(() => setSavedOpen(true)).catch(() => setSavedOpen(true)); };
    const onPins = () => { if (activeChannelId) void loadPinned().then(() => setPinnedOpen(true)).catch(() => setPinnedOpen(true)); };
    const onRefresh = () => { if (savedOpen) void loadSaved().catch(() => undefined); };
    const onShortcut = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(true); } };
    window.addEventListener('unichat:activity-open', onActivity);
    window.addEventListener('unichat:search-open', onSearch);
    window.addEventListener('unichat:saved-open', onSaved);
    window.addEventListener('unichat:pins-open', onPins);
    window.addEventListener('unichat:saved-refresh', onRefresh);
    window.addEventListener('keydown', onShortcut);
    return () => {
      window.removeEventListener('unichat:activity-open', onActivity);
      window.removeEventListener('unichat:search-open', onSearch);
      window.removeEventListener('unichat:saved-open', onSaved);
      window.removeEventListener('unichat:pins-open', onPins);
      window.removeEventListener('unichat:saved-refresh', onRefresh);
      window.removeEventListener('keydown', onShortcut);
    };
  }, [activeChannelId, loadPinned, loadSaved, savedOpen]);

  return <Suspense fallback={<div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/20 text-xs text-[var(--text)]" role="status"><span className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-3 shadow-lg">Loading panel…</span></div>}>
    {activityOpen && <ActivityCenter workspaceId={props.workspace._id} workspaceName={props.workspace.name} channels={props.channels} dms={props.dms} members={members} onClose={() => setActivityOpen(false)} onOpen={(notification: NotificationItem) => { setActivityOpen(false); window.dispatchEvent(new CustomEvent('unichat:activity-item', { detail: notification })); }} />}
    {searchOpen && <SearchModal workspaceId={props.workspace._id} channels={props.channels} members={members} onClose={() => setSearchOpen(false)} onOpenResult={(result: SearchResult) => { setSearchOpen(false); window.dispatchEvent(new CustomEvent('unichat:search-result', { detail: result })); }} />}
    {savedOpen && <SavedMessages items={savedItems} error={savedError} onRetry={() => void loadSaved().catch(() => undefined)} members={members} onClose={() => setSavedOpen(false)} onOpen={(item) => { setSavedOpen(false); window.dispatchEvent(new CustomEvent('unichat:saved-item', { detail: item })); }} onUnsave={(item) => window.dispatchEvent(new CustomEvent('unichat:unsave', { detail: item.message }))} />}
    {pinnedOpen && <PinnedMessages items={pinnedItems} error={pinnedError} onRetry={() => void loadPinned().catch(() => undefined)} members={members} onClose={() => setPinnedOpen(false)} onOpen={(item) => { setPinnedOpen(false); window.dispatchEvent(new CustomEvent('unichat:pinned-item', { detail: item })); }} />}
  </Suspense>;
}

export default function AppShell(props: Props) {
  const sidebar = useSidebarWidth();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [compactLayout, setCompactLayout] = useState(() => window.innerWidth < 640);
  useEffect(() => { setMobileSidebarOpen(false); }, [props.workspace._id]);
  useEffect(() => {
    const onResize = () => { const compact = window.innerWidth < 640; setCompactLayout(compact); if (!compact) setMobileSidebarOpen(false); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const onEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileSidebarOpen(false); };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [mobileSidebarOpen]);
  const [liveActivityUnreadCount, setLiveActivityUnreadCount] = useState(props.activityUnreadCount || 0);
  useEffect(() => {
    setLiveActivityUnreadCount(props.activityUnreadCount || 0);
    const onCount = (event: Event) => setLiveActivityUnreadCount((event as CustomEvent<{ count: number }>).detail.count);
    window.addEventListener('unichat:activity-count', onCount);
    return () => window.removeEventListener('unichat:activity-count', onCount);
  }, [props.activityUnreadCount]);

  const openActivity = () => { window.dispatchEvent(new CustomEvent('unichat:activity-open')); };
  return <div ref={sidebar.rootRef} data-mobile-sidebar-open={mobileSidebarOpen} className="flex h-dvh min-w-0 flex-col overflow-hidden bg-[var(--background)]" style={{ '--workspace-sidebar-width': `${sidebar.width}px` } as CSSProperties}>
    <TopBar user={props.user} workspaceName={props.workspace.name} socketConnected={props.socketConnected} activityUnreadCount={liveActivityUnreadCount} onLogout={props.onLogout} onSearch={props.onSearch} onActivity={openActivity} onToggleSidebar={() => setMobileSidebarOpen((open) => !open)} sidebarOpen={mobileSidebarOpen} />
    <div className="flex min-h-0 flex-1">
      <WorkspaceRail workspaces={props.workspaces} activeId={props.workspace._id} hasUnread={props.workspaceHasUnread || liveActivityUnreadCount > 0} onSelect={(id) => { setMobileSidebarOpen(false); props.onWorkspace(id); }} onAdd={props.onAddWorkspace} />
      {mobileSidebarOpen && <button type="button" className="sidebar-backdrop" onClick={() => setMobileSidebarOpen(false)} aria-label="Close workspace sidebar" />}
      <WorkspaceSidebar onOpenMembers={props.onOpenMembers} workspace={props.workspace} currentUserId={props.user._id} channels={props.channels} dms={props.dms} activeType={props.activeType} activeId={props.activeId} unreadChannels={props.unreadChannels} unreadDMs={props.unreadDMs} mentionChannels={props.mentionChannels} mentionDMs={props.mentionDMs} mobileHidden={compactLayout && !mobileSidebarOpen} onChannel={(channel) => { setMobileSidebarOpen(false); props.onChannel(channel); }} onDM={(dm) => { setMobileSidebarOpen(false); props.onDM(dm); }} onCreateChannel={() => { setMobileSidebarOpen(false); props.onCreateChannel(); }} onNewMessage={() => { setMobileSidebarOpen(false); props.onNewMessage(); }} onWorkspaces={props.onAddWorkspace} onSaved={() => { setMobileSidebarOpen(false); if (props.onSaved) props.onSaved(); else window.dispatchEvent(new CustomEvent('unichat:saved-open')); }} activityUnreadCount={liveActivityUnreadCount} onActivity={() => { setMobileSidebarOpen(false); openActivity(); }} />
      <div className="sidebar-resizer" role="separator" aria-label="Resize workspace sidebar" aria-controls="workspace-sidebar" aria-orientation="vertical" aria-valuemin={sidebar.minWidth} aria-valuemax={sidebar.maxWidth} aria-valuenow={sidebar.width} tabIndex={0} title="Drag to resize · double-click to reset" onPointerDown={sidebar.onPointerDown} onPointerMove={sidebar.onPointerMove} onPointerUp={sidebar.onPointerEnd} onPointerCancel={sidebar.onPointerEnd} onKeyDown={sidebar.onKeyDown} onDoubleClick={sidebar.reset} />
      {props.children}
    </div>
    <FeatureOverlays props={props} />
  </div>;
}
