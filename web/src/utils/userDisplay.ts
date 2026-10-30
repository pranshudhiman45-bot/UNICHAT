import type { User } from '../types';

export type UserLike = Partial<User> & {
  id?: string;
  name?: string;
  email?: string;
};

export function getUserDisplayName(user?: UserLike | null): string {
  if (!user) return 'Unknown user';
  const emailName = typeof user.email === 'string' ? user.email.split('@')[0] : '';
  return user.displayName?.trim() || user.name?.trim() || user.username?.trim() || emailName.trim() || 'Unknown user';
}

export function getUserHandle(user?: UserLike | null): string {
  const username = user?.username?.trim();
  return username ? `@${username}` : '@unknown';
}

export function getUserId(user?: UserLike | string | null): string | undefined {
  if (typeof user === 'string') return user;
  return user?._id || user?.id;
}

export function replaceMentionTokens(content: string | undefined, users: UserLike[] = []): string {
  if (!content) return '';
  const byId = new Map(users.map((user) => [getUserId(user)?.toLowerCase(), user]));
  return content.replace(/<@([a-f\d]{24})>|@([a-zA-Z0-9_.-]+)/gi, (token, id: string | undefined, username: string | undefined) => {
    if (id) return `@${getUserDisplayName(byId.get(id.toLowerCase()))}`;
    return username ? `@${username}` : token;
  });
}

export function getDisplayText(content: string | undefined, users: UserLike[] = []): string {
  return replaceMentionTokens(content, users) || 'Attachment';
}

