import type { User } from '../../types';

interface AvatarProps {
  user?: Partial<User> | null;
  name?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  showPresence?: boolean;
}

const sizes = { xs: 'h-5 w-5 text-[8px]', sm: 'h-7 w-7 text-[10px]', md: 'h-9 w-9 text-xs', lg: 'h-11 w-11 text-sm', xl: 'h-16 w-16 text-lg' };

export default function Avatar({ user, name, size = 'md', showPresence = false }: AvatarProps) {
  const label = user?.displayName || name || '?';
  const initials = label.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase();
  return (
    <span className="relative inline-flex shrink-0">
      {user?.avatar ? (
        <img src={user.avatar} alt={label} className={`${sizes[size]} rounded-full object-cover`} />
      ) : (
        <span className={`${sizes[size]} inline-flex items-center justify-center rounded-full bg-[var(--accent-soft)] font-semibold text-[var(--accent)]`}>{initials}</span>
      )}
      {showPresence && <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--surface)]" style={{ backgroundColor: user?.status === 'online' ? 'var(--online)' : user?.status === 'away' ? 'var(--away)' : user?.status === 'busy' ? 'var(--busy)' : 'var(--offline)' }} title={user?.status || 'Offline'} />}
    </span>
  );
}
