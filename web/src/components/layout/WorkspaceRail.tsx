import type { Workspace } from '../../types';
import UiIcon from '../common/UiIcon';
import WorkspaceAvatar from '../common/WorkspaceAvatar';

export default function WorkspaceRail({ workspaces, activeId, hasUnread, onSelect, onAdd }: { workspaces: Workspace[]; activeId?: string; hasUnread?: boolean; onSelect: (id: string) => void; onAdd: () => void }) {
  return (
    <aside className="flex w-[56px] shrink-0 flex-col items-center bg-[var(--rail)] py-3 text-white" aria-label="Workspace switcher">
      <div className="brand-tile mb-6 h-9 w-9 text-base">U</div>
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-3 overflow-y-auto">
        {workspaces.map((workspace) => (
          <button key={workspace._id} type="button" onClick={() => onSelect(workspace._id)} title={workspace.name} aria-label={`Open ${workspace.name} workspace`} aria-current={workspace._id === activeId ? 'page' : undefined} className={`workspace-rail-item relative flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] ${workspace._id === activeId ? 'workspace-rail-item-active' : ''}`}>
            <WorkspaceAvatar workspace={workspace} size={38} />
            {workspace._id === activeId && <span className="absolute -left-3 h-6 w-1 rounded-r bg-[var(--gold)]" />}{workspace._id === activeId && hasUnread && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-[var(--rail)] bg-[var(--error)]" aria-label="Unread messages" />}
          </button>
        ))}
        <button type="button" onClick={onAdd} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-dashed border-[rgba(212,175,98,.4)] text-[var(--gold-soft)]/80 hover:border-[var(--gold)] hover:text-[var(--gold-soft)]" title="All workspaces" aria-label="All workspaces"><UiIcon name="plus" size={18} /></button>
      </div>
    </aside>
  );
}
