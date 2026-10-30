import { useState } from 'react';
import { api } from '../../hooks/useAuth';
import type { Channel, SearchResult, User } from '../../types';
import Modal from '../common/Modal';
import SearchFilters from './SearchFilters';
import SearchResults from './SearchResults';

interface Props {
  workspaceId: string;
  channels: Channel[];
  members: User[];
  onClose: () => void;
  onOpenResult: (result: SearchResult) => void;
}

export default function SearchModal({ workspaceId, channels, members, onClose, onOpenResult }: Props) {
  const [query, setQuery] = useState('');
  const [channelId, setChannelId] = useState('');
  const [senderId, setSenderId] = useState('');
  const [hasAttachments, setHasAttachments] = useState<'all' | 'true' | 'false'>('all');
  const [after, setAfter] = useState('');
  const [before, setBefore] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');

  const search = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!query.trim()) return;
    setLoading(true); setSearched(true); setError('');
    try {
      const params = new URLSearchParams({ workspaceId, q: query.trim() });
      if (channelId) params.set('channelId', channelId);
      if (senderId) params.set('senderId', senderId);
      if (hasAttachments !== 'all') params.set('hasAttachments', hasAttachments);
      if (after) params.set('after', after);
      if (before) params.set('before', before);
      const response = await api.get(`/search?${params.toString()}`);
      setResults(response.data.results || []);
    } catch (requestError: any) {
      setError(requestError.response?.data?.error || 'Search failed');
      setResults([]);
    } finally { setLoading(false); }
  };

  const updateFilter = (field: 'channelId' | 'senderId' | 'hasAttachments' | 'after' | 'before', value: string) => {
    if (field === 'channelId') setChannelId(value);
    if (field === 'senderId') setSenderId(value);
    if (field === 'hasAttachments') setHasAttachments(value as 'all' | 'true' | 'false');
    if (field === 'after') setAfter(value);
    if (field === 'before') setBefore(value);
  };

  return <Modal title="Search Unichat" onClose={onClose}><form onSubmit={(event) => void search(event)}><div className="flex gap-2"><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search messages and files" className="min-w-0 flex-1 border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]" aria-label="Search messages" /><button type="submit" disabled={!query.trim() || loading} className="bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">Search</button></div><SearchFilters channels={channels} members={members} channelId={channelId} senderId={senderId} hasAttachments={hasAttachments} after={after} before={before} onChange={updateFilter} /></form>{error && <p className="px-5 py-3 text-xs text-[var(--error)]" role="alert">{error}</p>}<SearchResults results={results} query={query} loading={loading} searched={searched} members={members} onOpen={onOpenResult} /></Modal>;
}
