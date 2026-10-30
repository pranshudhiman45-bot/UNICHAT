import type { Channel, User } from '../../types';

interface Props {
  channels: Channel[];
  members: User[];
  channelId: string;
  senderId: string;
  hasAttachments: 'all' | 'true' | 'false';
  after: string;
  before: string;
  onChange: (field: 'channelId' | 'senderId' | 'hasAttachments' | 'after' | 'before', value: string) => void;
}

export default function SearchFilters({ channels, members, channelId, senderId, hasAttachments, after, before, onChange }: Props) {
  return <div className="grid grid-cols-2 gap-2 border-b border-slate-200 px-5 py-3 sm:grid-cols-5">
    <select value={channelId} onChange={(event) => onChange('channelId', event.target.value)} className="border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-slate-600" aria-label="Filter by channel"><option value="">All conversations</option>{channels.map((channel) => <option key={channel._id} value={channel._id}>#{channel.name}</option>)}</select>
    <select value={senderId} onChange={(event) => onChange('senderId', event.target.value)} className="border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-slate-600" aria-label="Filter by sender"><option value="">All senders</option>{members.map((member) => <option key={member._id} value={member._id}>{member.displayName}</option>)}</select>
    <select value={hasAttachments} onChange={(event) => onChange('hasAttachments', event.target.value)} className="border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-slate-600" aria-label="Filter by attachments"><option value="all">Any message</option><option value="true">Has attachments</option><option value="false">No attachments</option></select>
    <input type="date" value={after} onChange={(event) => onChange('after', event.target.value)} className="border border-slate-200 px-2 py-1.5 text-[11px] text-slate-600" aria-label="After date" />
    <input type="date" value={before} onChange={(event) => onChange('before', event.target.value)} className="border border-slate-200 px-2 py-1.5 text-[11px] text-slate-600" aria-label="Before date" />
  </div>;
}
