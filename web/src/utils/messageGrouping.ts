import type { Message } from '../types';

export function isGroupedMessage(previous: Message | undefined, current: Message): boolean {
  if (!previous || previous.isSystemMessage || current.isSystemMessage || previous.forwardedFrom || current.forwardedFrom) return false;
  if (!previous.sender?._id || previous.sender._id !== current.sender?._id) return false;
  const earlier = new Date(previous.createdAt);
  const later = new Date(current.createdAt);
  const gap = later.getTime() - earlier.getTime();
  return Number.isFinite(gap) && gap >= 0 && gap <= 5 * 60 * 1000 && earlier.toDateString() === later.toDateString();
}
