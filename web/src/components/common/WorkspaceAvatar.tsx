import { useState, type CSSProperties } from 'react';
import type { Workspace } from '../../types';
import { getWorkspaceAvatarDesign, getWorkspaceImageUrl, getWorkspaceInitials, type WorkspaceAvatarMotif } from '../../../../shared/workspaceAvatar';
import UiIcon from './UiIcon';

interface Props {
  workspace: Pick<Workspace, 'name' | 'icon'>;
  size?: number;
  className?: string;
}

function MotifIcon({ motif, size }: { motif: Exclude<WorkspaceAvatarMotif, 'initials'>; size: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {motif === 'chat' && <><path d="M4 5.5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z" /><path d="M8 9h5m-5 3h3M18 9h2a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1v2l-3-2h-2" /></>}
    {motif === 'code' && <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16" /></>}
    {motif === 'megaphone' && <><path d="M3 10v4a2 2 0 0 0 2 2h2l2 5h3l-2-5h2l8 4V4l-8 4H5a2 2 0 0 0-2 2Zm17 0a3 3 0 0 1 0 4" /></>}
    {motif === 'palette' && <><path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.4-3.4 1.8 1.8 0 0 1 1.2-3.1H18A3 3 0 0 0 21 11a9 9 0 0 0-9-8Z" /><path d="M7.5 10h.01M11 7h.01M16 8h.01M7 15h.01" strokeWidth="3" /></>}
    {motif === 'chart' && <><path d="M4 19h16M6 16v-4m5 4V9m5 7V5m-11 5 6-4 5 2 4-4" /></>}
    {motif === 'book' && <><path d="M12 6C9 4 6 4 3 5v13c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v13" /></>}
    {motif === 'leaf' && <><path d="M20 4C9 4 4 9 4 15a5 5 0 0 0 5 5c6 0 11-5 11-16ZM4 20c3-6 7-9 12-11" /></>}
    {motif === 'people' && <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2H3Zm13-14a3 3 0 0 1 0 6m1 3a5 5 0 0 1 4 5h-3" /></>}
    {motif === 'check' && <><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></>}
  </svg>;
}

export default function WorkspaceAvatar({ workspace, size = 40, className = '' }: Props) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const imageUrl = getWorkspaceImageUrl(workspace.icon);
  const showImage = imageUrl && failedUrl !== imageUrl;
  const legacyIcon = !imageUrl && workspace.icon?.trim();
  const generated = !showImage && !legacyIcon;
  const initials = getWorkspaceInitials(workspace.name);
  const design = getWorkspaceAvatarDesign(workspace.name);
  const label = `${workspace.name?.trim() || 'Unnamed'} workspace`;
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.round(size / 4),
    fontSize: size <= 32 ? 13 : size <= 40 ? 15 : 20,
    background: generated ? `linear-gradient(140deg, ${design.startColor}, ${design.endColor})` : design.startColor,
  };

  return <span className={`workspace-avatar ${generated ? 'workspace-avatar-generated' : ''} inline-flex shrink-0 items-center justify-center overflow-hidden text-center font-semibold text-white ${className}`} style={style}>
    {showImage ? <img src={imageUrl} alt={label} className="relative z-10 h-full w-full object-cover" onError={() => setFailedUrl(imageUrl)} />
      : <span role="img" aria-label={label} className="relative z-10 flex h-full w-full items-center justify-center">
        {legacyIcon || (design.motif === 'initials'
          ? initials || <UiIcon name="grid" size={Math.round(size * .52)} />
          : <MotifIcon motif={design.motif} size={Math.round(size * .58)} />)}
      </span>}
  </span>;
}
