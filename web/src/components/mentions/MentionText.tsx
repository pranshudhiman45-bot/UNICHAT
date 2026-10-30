import type { ReactNode } from 'react';
import type { User } from '../../types';
import { getUserDisplayName } from '../../utils/userDisplay';

interface Props { content: string; mentions?: string[]; members: User[]; }

export default function MentionText({ content, mentions = [], members }: Props) {
  const mentionedIds = new Set(mentions.map(String));
  const membersById = new Map(members.map((user) => [user._id, user]));
  const membersByUsername = new Map(members.map((user) => [user.username.toLowerCase(), user]));
  const tokenRegex = /<@([a-f\d]{24})>|@([a-zA-Z0-9_.-]+)/gi;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(content))) {
    parts.push(content.slice(cursor, match.index));
    const user = match[1] ? membersById.get(match[1]) : membersByUsername.get(match[2].toLowerCase());
    const isMention = Boolean(user && mentionedIds.has(user._id));
    if (isMention) parts.push(<span key={`${match.index}-${user?._id}`} className="rounded bg-[var(--mention)] px-1 font-medium text-[var(--accent)]">@{user?.displayName || match[2]}</span>);
    else parts.push(match[1] ? `@${getUserDisplayName()}` : match[0]);
    cursor = match.index + match[0].length;
  }
  parts.push(content.slice(cursor));
  return <>{parts}</>;
}
