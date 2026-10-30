import type { SearchResult } from '../../types';
import Avatar from '../common/Avatar';
import type { User } from '../../types';
import { getDisplayText, getUserDisplayName } from '../../utils/userDisplay';

function HighlightedText({ content, query }: { content: string; query: string }) {
  if (!query) return <>{content}</>;
  const parts = content.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')})`, 'ig'));
  return <>{parts.map((part, index) => part.toLowerCase() === query.toLowerCase() ? <mark key={`${part}-${index}`} className="bg-indigo-100 px-0.5 text-indigo-800">{part}</mark> : part)}</>;
}

interface Props {
  results: SearchResult[];
  query: string;
  loading: boolean;
  searched: boolean;
  onOpen: (result: SearchResult) => void;
  members: User[];
}

export default function SearchResults({ results, query, loading, searched, onOpen, members }: Props) {
  if (loading) return <p className="px-5 py-10 text-center text-xs text-slate-400">Searching workspace…</p>;
  if (searched && !results.length) return <p className="px-5 py-10 text-center text-xs text-slate-400">No accessible messages matched your search.</p>;
  return <div className="max-h-[55vh] overflow-y-auto divide-y divide-[var(--border)]">{results.map((result) => { const displayText = getDisplayText(result.content, members); return <button key={result._id} type="button" onClick={() => onOpen(result)} className="ui-interactive-row flex w-full gap-3 px-5 py-3 text-left"><Avatar user={result.sender} size="sm" /><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2 text-[11px]"><strong className="text-[var(--text)]">{getUserDisplayName(result.sender)}</strong><span className="text-[var(--text-muted)]">{result.conversation?.name || 'Conversation'}</span><span className="text-[var(--text-muted)]">{new Date(result.createdAt).toLocaleString()}</span>{result.isThreadReply && <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-600">Thread</span>}{result.attachments?.length ? <span className="text-[var(--text-muted)]">📎 {result.attachments.length}</span> : null}</span><span className="mt-1 block break-words text-xs leading-5 text-[var(--text-secondary)]">{result.content ? <HighlightedText content={displayText} query={query} /> : <span className="italic text-[var(--text-muted)]">Attachment</span>}</span>{result.attachments?.some((attachment) => attachment.name) && <span className="mt-1 block truncate text-[10px] text-[var(--text-muted)]">Files: {result.attachments.map((attachment) => attachment.name).filter(Boolean).join(', ')}</span>}</span></button>; })}</div>;
}
