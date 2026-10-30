import { useEffect, useRef, useState } from 'react';
import Avatar from '../common/Avatar';
import UiIcon from '../common/UiIcon';
import LogoutDialog from '../common/LogoutDialog';
import EditProfileDialog from '../profile/EditProfileDialog';
import type { User } from '../../types';
import { useTheme, type ThemeMode } from '../../hooks/useTheme';

interface Props {
  user: User;
  workspaceName: string;
  socketConnected: boolean;
  activityUnreadCount: number;
  onLogout: () => Promise<void>;
  onSearch?: () => void;
  onActivity: () => void;
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
}

export default function TopBar({ user, workspaceName, socketConnected, activityUnreadCount, onLogout, onSearch, onActivity, onToggleSidebar, sidebarOpen }: Props) {
  const [profileOpen, setProfileOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const { theme, setTheme } = useTheme();
  useEffect(() => {
    if (!profileOpen) return;
    const onPointerDown = (event: PointerEvent) => { if (!profileRef.current?.contains(event.target as Node)) setProfileOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setProfileOpen(false); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [profileOpen]);
  const search = () => { if (onSearch) onSearch(); else window.dispatchEvent(new CustomEvent('unichat:search-open')); };

  return <>
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[var(--header-border)] bg-[var(--header-bg)] px-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <button type="button" onClick={onToggleSidebar} className="rounded p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-surface-secondary)] sm:hidden" aria-label="Toggle workspace sidebar" aria-controls="workspace-sidebar" aria-expanded={sidebarOpen}><UiIcon name="menu" size={20} /></button>
        <span className="brand-tile h-7 w-7 shrink-0 rounded-lg text-[13px]" aria-hidden="true">U</span>
        <span className="hidden text-[11px] font-semibold tracking-[.22em] text-[var(--text)] sm:block" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>UNICHAT</span>
        <span className="mx-1 hidden h-5 w-px bg-[var(--border)] md:block" aria-hidden="true" />
        <button type="button" onClick={() => window.history.back()} className="hidden rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-surface-secondary)] hover:text-[var(--text)] md:block" aria-label="Go back" title="Go back"><UiIcon name="chevronLeft" size={16} /></button>
        <button type="button" onClick={() => window.history.forward()} className="hidden rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-surface-secondary)] hover:text-[var(--text)] md:block" aria-label="Go forward" title="Go forward"><UiIcon name="chevronRight" size={16} /></button>
        <span className="truncate text-xs font-medium text-[var(--text-secondary)]" title={workspaceName}>{workspaceName}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <button type="button" onClick={search} className="topbar-search flex h-8 items-center gap-2 rounded-md border px-2.5 text-xs text-[var(--text-secondary)] sm:w-[clamp(150px,22vw,290px)]" aria-label="Search Unichat"><UiIcon name="search" size={16} /><span className="hidden sm:inline">Search Unichat</span><kbd className="ml-auto hidden font-mono text-[10px] text-[var(--text-muted)] lg:inline">Ctrl K</kbd></button>
        <span className={`hidden items-center gap-1.5 text-[11px] lg:flex ${socketConnected ? 'text-[var(--success-text)]' : 'text-[var(--warning-text)]'}`} role="status"><span className={`h-1.5 w-1.5 rounded-full ${socketConnected ? 'bg-[var(--online)]' : 'bg-[var(--warning)]'}`} />{socketConnected ? 'Connected' : 'Reconnecting…'}</span>
        <button type="button" onClick={onActivity} className="relative rounded p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-surface-secondary)] hover:text-[var(--accent)]" title="Open activity" aria-label="Open activity"><UiIcon name="bell" />{activityUnreadCount > 0 && <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-[var(--error)] px-1 text-[9px] font-bold leading-4 text-white">{activityUnreadCount > 99 ? '99+' : activityUnreadCount}</span>}</button>
        <div ref={profileRef} className="relative">
          <button type="button" className="flex items-center gap-1.5 rounded p-1 hover:bg-[var(--bg-surface-secondary)]" onClick={() => setProfileOpen((open) => !open)} aria-expanded={profileOpen} aria-haspopup="dialog" aria-label="Account and appearance"><Avatar user={user} size="sm" showPresence /><span className="hidden max-w-28 truncate text-xs font-medium text-[var(--text)] xl:inline">{user.displayName}</span><span className="text-[var(--text-muted)]"><UiIcon name="chevronDown" size={13} /></span></button>
          {profileOpen && <div className="absolute right-0 top-10 z-40 w-[min(270px,calc(100vw-16px))] rounded-lg border border-[var(--border)] bg-[var(--popup-bg)] p-3 text-[var(--text)] shadow-lg" role="dialog" aria-label="Account and appearance">
            <div className="flex items-center gap-2 border-b border-[var(--border)] pb-3"><Avatar user={user} size="md" showPresence /><div className="min-w-0"><p className="truncate text-xs font-semibold">{user.displayName}</p><p className="truncate text-[10px] text-[var(--text-muted)]">@{user.username}</p></div></div>
            <p className="py-3 text-[11px] text-[var(--text-secondary)]">{user.title || 'Unichat member'}</p>
            <button type="button" onClick={() => { setProfileOpen(false); setEditProfileOpen(true); }} className="mb-3 w-full rounded-md border border-[var(--border)] bg-[var(--bg-surface-secondary)] px-3 py-2 text-left text-xs font-medium text-[var(--text)] hover:border-[var(--accent)]">Edit profile</button>
            <label className="mb-3 block text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Appearance<select aria-label="Appearance" value={theme} onChange={(event) => setTheme(event.target.value as ThemeMode)} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs text-[var(--text)]"><option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option></select></label>
            <button type="button" onClick={() => { setProfileOpen(false); setLogoutOpen(true); }} className="w-full rounded-md border border-red-200 px-3 py-2 text-left text-xs font-medium text-red-600 hover:bg-red-50">Log out…</button>
          </div>}
        </div>
      </div>
    </header>
    {logoutOpen && <LogoutDialog onClose={() => setLogoutOpen(false)} onLogout={onLogout} />}
    {editProfileOpen && <EditProfileDialog onClose={() => setEditProfileOpen(false)} />}
  </>;
}
