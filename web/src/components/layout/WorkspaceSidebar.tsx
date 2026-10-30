import { useEffect, useRef, useState } from 'react';
import type { Channel, DirectMessage, User, Workspace } from '../../types';
import Avatar from '../common/Avatar';
import UiIcon from '../common/UiIcon';
import WorkspaceAvatar from '../common/WorkspaceAvatar';
import { getUserDisplayName } from '../../utils/userDisplay';

interface Props {
  workspace: Workspace;
  currentUserId: string;
  channels: Channel[];
  dms: DirectMessage[];
  activeType: 'channel' | 'dm';
  activeId?: string;
  unreadChannels: Record<string, number>;
  unreadDMs: Record<string, number>;
  mentionChannels: Record<string, number>;
  mentionDMs: Record<string, number>;
  onChannel: (channel: Channel) => void;
  onDM: (dm: DirectMessage) => void;
  onCreateChannel: () => void;
  onNewMessage: () => void;
  onOpenMembers?: () => void;
  onWorkspaces: () => void;
  onSaved?: () => void;
  activityUnreadCount: number;
  onActivity: () => void;
  mobileHidden?: boolean;
}

function dmTitle(dm: DirectMessage, currentId: string) {
  if (dm.isGroup) return dm.groupName || dm.participants.filter((user) => user._id !== currentId).map(getUserDisplayName).join(', ') || 'Group DM';
  return getUserDisplayName(dm.participants.find((user) => user._id !== currentId));
}

function dmUser(dm: DirectMessage, currentId: string): User | undefined {
  return dm.participants.find((user) => user._id !== currentId);
}

function UnreadBadge({ count }: { count: number }) {
  return <span className="rounded-full bg-[var(--gold)] px-1.5 py-[3px] text-[10px] font-bold leading-none text-[var(--gold-ink)] shadow-sm" aria-label={`${count} unread`}>{count > 99 ? '99+' : count}</span>;
}

export default function WorkspaceSidebar({ onOpenMembers, workspace, currentUserId, channels, dms, activeType, activeId, unreadChannels, unreadDMs, mentionChannels, mentionDMs, onChannel, onDM, onCreateChannel, onNewMessage, onWorkspaces, onSaved, activityUnreadCount, onActivity, mobileHidden = false }: Props) {
  const canManage = workspace.members?.some(member => String(typeof member.user === 'object' ? member.user?._id : member.user) === currentUserId && ['owner', 'admin'].includes(member.role));
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!workspaceMenuOpen) return;
    const onOutside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setWorkspaceMenuOpen(false); };
    const onEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setWorkspaceMenuOpen(false); };
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('keydown', onEscape);
    return () => { document.removeEventListener('pointerdown', onOutside); document.removeEventListener('keydown', onEscape); };
  }, [workspaceMenuOpen]);

  return <aside id="workspace-sidebar" className="flex w-[var(--workspace-sidebar-width)] shrink-0 flex-col bg-[var(--sidebar)] text-white" aria-label="Workspace sidebar" aria-hidden={mobileHidden} inert={mobileHidden}>
    <div ref={menuRef} className="relative flex h-12 shrink-0 items-center border-b border-white/10 px-3">
      <button type="button" onClick={() => setWorkspaceMenuOpen((open) => !open)} className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-1 text-left hover:bg-white/10" aria-expanded={workspaceMenuOpen} aria-haspopup="dialog" aria-label={`${workspace.name} workspace menu`}>
        <WorkspaceAvatar workspace={workspace} size={32} /><span className="min-w-0"><span className="block truncate text-sm font-semibold">{workspace.name}</span><span className="block text-[10px] text-white/60">Team workspace</span></span><UiIcon name="chevronDown" size={15} />
      </button>
      {workspaceMenuOpen && <div className="absolute left-3 right-3 top-11 z-30 rounded-md border border-white/10 bg-[var(--sidebar)] p-2 shadow-xl" role="dialog" aria-label="Workspace menu">
        <div className="border-b border-white/10 px-2 pb-2"><div className="flex items-center gap-2"><WorkspaceAvatar workspace={workspace} size={32} /><p className="truncate text-xs font-semibold">{workspace.name}</p></div><p className="mt-1 text-[10px] text-white/60">{workspace.description || 'Team workspace'}</p>{workspace.inviteCode && <p className="mt-2 font-mono text-[10px] text-white/70">Invite code: {workspace.inviteCode}</p>}</div>
        <button type="button" onClick={() => { setWorkspaceMenuOpen(false); onCreateChannel(); }} className="mt-1 flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs text-white/80 hover:bg-white/10"><UiIcon name="plus" size={15} />Create channel</button>
        {onOpenMembers && <button type="button" onClick={() => { setWorkspaceMenuOpen(false); onOpenMembers(); }} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs text-white/80 hover:bg-white/10"><UiIcon name="users" size={15} />Members &amp; roles</button>}
        <button type="button" onClick={() => { setWorkspaceMenuOpen(false); onWorkspaces(); }} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs text-white/80 hover:bg-white/10"><UiIcon name="layers" size={15} />All workspaces</button>
      </div>}
    </div>
    <nav className="space-y-0.5 border-b border-white/10 p-2" aria-label="Workspace shortcuts">
      <button type="button" onClick={onWorkspaces} className="sidebar-shortcut flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[13.5px] font-medium text-white/80"><span className="sidebar-icon"><UiIcon name="layers" size={17} /></span>Workspaces</button>
      {canManage && <button type="button" onClick={onWorkspaces} className="sidebar-shortcut flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[13.5px] font-medium text-white/80"><span className="sidebar-icon"><UiIcon name="shield" size={17} /></span>Manage access</button>}
      <button type="button" onClick={onActivity} className="sidebar-shortcut flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[13.5px] font-medium text-white/80"><span className="sidebar-icon"><UiIcon name="activity" size={17} /></span>Activity{activityUnreadCount > 0 && <span className="ml-auto"><UnreadBadge count={activityUnreadCount} /></span>}</button>
      <button type="button" onClick={() => { if (onSaved) onSaved(); else window.dispatchEvent(new CustomEvent('unichat:saved-open')); }} className="sidebar-shortcut flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[13.5px] font-medium text-white/80"><span className="sidebar-icon"><UiIcon name="bookmark" size={17} /></span>Later / Saved</button>
    </nav>
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
      <div className="mb-1 flex items-center justify-between px-2"><p className="sidebar-section-label">Channels</p><button type="button" onClick={onCreateChannel} className="rounded p-1 text-white/60 hover:bg-[var(--sidebar-hover)] hover:text-white" title="Create channel" aria-label="Create channel"><UiIcon name="plus" size={15} /></button></div>
      {channels.length === 0 && <p className="px-2 py-1 text-xs text-white/50">No channels yet.</p>}
      <div className="space-y-0.5">{channels.map((channel) => {
        const count = unreadChannels[channel._id] ?? channel.unreadCount ?? 0;
        const mentions = mentionChannels[channel._id] ?? channel.mentionCount ?? 0;
        const selected = activeType === 'channel' && activeId === channel._id;
        return <button type="button" key={channel._id} onClick={() => onChannel(channel)} title={channel.name} aria-current={selected ? 'page' : undefined} className={`sidebar-row flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium ${selected ? 'sidebar-row-active text-white' : 'text-white/80'} ${count ? 'font-semibold text-white' : ''}`}>
          <span className="sidebar-icon shrink-0"><UiIcon name={channel.type === 'private' ? 'lock' : 'hash'} size={15} /></span><span className="min-w-0 flex-1 truncate">{channel.name}</span>{channel.isMuted && <span className="text-white/60" aria-label="Muted"><UiIcon name="mute" size={13} /></span>}{mentions > 0 && <span className="text-[10px] text-indigo-200" aria-label={`${mentions} mentions`}>@{mentions}</span>}{count > 0 && <UnreadBadge count={count} />}
        </button>;
      })}</div>
      <div className="mb-1 mt-5 flex items-center justify-between px-2"><p className="sidebar-section-label">Direct messages</p><button type="button" onClick={onNewMessage} className="rounded p-1 text-white/60 hover:bg-[var(--sidebar-hover)] hover:text-white" title="New message" aria-label="New message"><UiIcon name="plus" size={15} /></button></div>
      {dms.length === 0 && <p className="px-2 py-1 text-xs text-white/50">No direct messages yet.</p>}
      <div className="space-y-0.5">{dms.map((dm) => {
        const count = unreadDMs[dm._id] ?? dm.unreadCount ?? 0;
        const mentions = mentionDMs[dm._id] ?? dm.mentionCount ?? 0;
        const selected = activeType === 'dm' && activeId === dm._id;
        return <button type="button" key={dm._id} onClick={() => onDM(dm)} title={dmTitle(dm, currentUserId)} aria-current={selected ? 'page' : undefined} className={`sidebar-row flex min-h-10 w-full items-center gap-2 rounded-md px-2 py-1 text-left ${selected ? 'sidebar-row-active' : ''}`}>
          {dm.isGroup ? <span className="flex shrink-0 -space-x-2">{dm.participants.slice(0, 3).map((member) => <Avatar key={member._id} user={member} size="sm" />)}</span> : <Avatar user={dmUser(dm, currentUserId)} name={dmTitle(dm, currentUserId)} size="sm" showPresence />}
          <span className={`min-w-0 flex-1 truncate text-sm ${count ? 'font-semibold text-white' : 'font-medium text-white/80'}`}>{dmTitle(dm, currentUserId)}</span>{dm.isMuted && <span className="text-white/60" aria-label="Muted"><UiIcon name="mute" size={13} /></span>}{mentions > 0 && <span className="text-[10px] text-indigo-200" aria-label={`${mentions} mentions`}>@{mentions}</span>}{count > 0 && <UnreadBadge count={count} />}
        </button>;
      })}</div>
    </div>
  </aside>;
}

export { dmTitle };
