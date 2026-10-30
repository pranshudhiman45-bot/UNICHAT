import type { Reaction } from '../../types';

interface Props { reactions?: Reaction[]; currentUserId: string; onToggle: (emoji: string, selected: boolean) => void; disabled?: boolean; }

export default function ReactionBar({ reactions = [], currentUserId, onToggle, disabled }: Props) {
  if (!reactions.length) return null;
  return <div className="mt-1 flex flex-wrap gap-1">{reactions.map((reaction) => { const selected = reaction.users.some((user) => String(user) === currentUserId); return <button type="button" key={reaction.emoji} disabled={disabled} onClick={() => onToggle(reaction.emoji, selected)} className={`rounded-full border px-2 py-0.5 text-[11px] transition ${selected ? 'border-[var(--accent)] bg-[var(--mention)] text-[var(--accent)]' : 'border-slate-200 bg-white text-slate-600 hover:border-[var(--accent)]'} disabled:opacity-50`} aria-label={`${reaction.count} ${reaction.emoji} reaction${reaction.count === 1 ? '' : 's'}`} title={`${reaction.count} reaction${reaction.count === 1 ? '' : 's'}`}>{reaction.emoji} {reaction.count}</button>; })}</div>;
}
