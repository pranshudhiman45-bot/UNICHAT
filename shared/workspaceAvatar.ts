export const WORKSPACE_AVATAR_COLORS = [
  '#7B4B94', '#2F5D9E', '#1F7A7A', '#2E7D5B',
  '#9C3350', '#A8743A', '#4B5A73', '#B0506E',
] as const;

const WORKSPACE_AVATAR_END_COLORS = [
  '#4F2A66', '#1B3A6B', '#135252', '#1B5239',
  '#6B1F36', '#75491B', '#2F3A4E', '#7A2E48',
] as const;

export type WorkspaceAvatarMotif = 'chat' | 'code' | 'megaphone' | 'palette' | 'chart' | 'book' | 'leaf' | 'people' | 'check' | 'initials';

const motifKeywords: { motif: Exclude<WorkspaceAvatarMotif, 'initials'>; words: readonly string[] }[] = [
  { motif: 'chat', words: ['unichat', 'chat', 'communication', 'message', 'connect'] },
  { motif: 'code', words: ['dev', 'development', 'engineering', 'software', 'tech', 'coding', 'code', 'programming'] },
  { motif: 'megaphone', words: ['marketing', 'sales', 'brand', 'advertising'] },
  { motif: 'palette', words: ['design', 'creative', 'art', 'studio', 'ux', 'product'] },
  { motif: 'chart', words: ['finance', 'accounting', 'budget', 'analytics', 'business'] },
  { motif: 'book', words: ['education', 'learning', 'school', 'training', 'research'] },
  { motif: 'leaf', words: ['wellness', 'health', 'nature', 'green', 'garden'] },
  { motif: 'people', words: ['team', 'group', 'community', 'people', 'social'] },
  { motif: 'check', words: ['test', 'testing', 'qa', 'quality'] },
];

const usableCharacter = /[\p{L}\p{N}]/u;

function normalizedName(name: string | null | undefined): string {
  return (name || '').normalize('NFC').trim().replace(/\s+/gu, ' ');
}

function firstUsableCharacter(word: string): string {
  return Array.from(word).find((character) => usableCharacter.test(character)) || '';
}

export function getWorkspaceInitials(name: string | null | undefined): string {
  const words = normalizedName(name).split(' ')
    .map(firstUsableCharacter)
    .filter(Boolean)
    .map((character) => Array.from(character.toLocaleUpperCase())[0]);
  if (!words.length) return '';
  return words.length === 1 ? words[0] : words[0] + words[words.length - 1];
}

export function getWorkspaceAvatarColor(name: string | null | undefined): string {
  const value = normalizedName(name).toLowerCase();
  let hash = 2166136261;
  for (const character of value) {
    hash = Math.imul(hash ^ (character.codePointAt(0) || 0), 16777619);
  }
  return WORKSPACE_AVATAR_COLORS[(hash >>> 0) % WORKSPACE_AVATAR_COLORS.length];
}

export function getWorkspaceAvatarDesign(name: string | null | undefined): {
  motif: WorkspaceAvatarMotif;
  startColor: string;
  endColor: string;
} {
  const colorIndex = WORKSPACE_AVATAR_COLORS.indexOf(getWorkspaceAvatarColor(name) as typeof WORKSPACE_AVATAR_COLORS[number]);
  const words = normalizedName(name).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const motif = motifKeywords.find((entry) => entry.words.some((word) => words.includes(word)))?.motif || 'initials';
  return {
    motif,
    startColor: WORKSPACE_AVATAR_COLORS[colorIndex],
    endColor: WORKSPACE_AVATAR_END_COLORS[colorIndex],
  };
}

export function getWorkspaceImageUrl(icon: string | null | undefined): string | null {
  if (!icon) return null;
  try {
    const url = new URL(icon.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}
