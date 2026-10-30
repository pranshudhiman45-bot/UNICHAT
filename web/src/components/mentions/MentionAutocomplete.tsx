import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { User } from '../../types';
import Avatar from '../common/Avatar';
import { getUserDisplayName, getUserHandle } from '../../utils/userDisplay';

const MENTION_POPUP_GAP = 4;
const MENTION_POPUP_MAX_HEIGHT = 224;

export interface MentionAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface Props {
  users: User[];
  activeIndex: number;
  anchor: MentionAnchor;
  contextMemberIds?: string[];
  contextType?: 'channel' | 'dm';
  onSelect: (user: User) => void;
  onDismiss: () => void;
}

export default function MentionAutocomplete({ users, activeIndex, anchor, contextMemberIds = [], contextType, onSelect, onDismiss }: Props) {
  const popupRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [position, setPosition] = useState({ left: anchor.left, top: anchor.bottom + MENTION_POPUP_GAP, maxHeight: MENTION_POPUP_MAX_HEIGHT });
  const activeUser = users[activeIndex];

  useLayoutEffect(() => {
    const updatePosition = () => {
      const popup = popupRef.current;
      const width = Math.min(420, window.innerWidth - 24);
      const measuredHeight = Math.min(popup?.scrollHeight || MENTION_POPUP_MAX_HEIGHT, MENTION_POPUP_MAX_HEIGHT);
      const left = Math.min(Math.max(anchor.left, 12), Math.max(12, window.innerWidth - width - 12));
      const spaceBelow = window.innerHeight - anchor.bottom - MENTION_POPUP_GAP - 12;
      const spaceAbove = anchor.top - MENTION_POPUP_GAP - 12;
      const flipAbove = spaceBelow < measuredHeight && spaceAbove > spaceBelow;
      const available = Math.max(0, Math.min(MENTION_POPUP_MAX_HEIGHT, flipAbove ? spaceAbove : spaceBelow));
      const visibleHeight = Math.min(measuredHeight, available);
      setPosition({ left, top: flipAbove ? Math.max(12, anchor.top - visibleHeight - MENTION_POPUP_GAP) : anchor.bottom + MENTION_POPUP_GAP, maxHeight: available });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => { window.removeEventListener('resize', updatePosition); window.removeEventListener('scroll', updatePosition, true); };
  }, [anchor.left, anchor.top, anchor.bottom, users.length]);

  useEffect(() => {
    activeUser && rowRefs.current[activeUser._id]?.scrollIntoView({ block: 'nearest' });
  }, [activeUser]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => { if (!popupRef.current?.contains(event.target as Node)) onDismiss(); };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onDismiss]);

  return createPortal(<div ref={popupRef} role="listbox" aria-label="Mention workspace member" className="mention-popover" style={{ left: position.left, top: position.top, maxHeight: position.maxHeight, width: 'min(420px, calc(100vw - 24px))' }}>
    {users.length ? users.map((user, index) => <button type="button" key={user._id} ref={(element) => { rowRefs.current[user._id] = element; }} role="option" aria-selected={index === activeIndex} onMouseDown={(event) => { event.preventDefault(); onSelect(user); }} className={`mention-popover-row ${index === activeIndex ? 'mention-popover-row-selected' : ''}`}>
      <Avatar user={user} size="xs" />
      <span className="mention-popover-identity"><span className="mention-popover-primary"><span className="mention-popover-name">{getUserDisplayName(user)}</span><span className={`mention-popover-status ${user.status === 'online' ? 'mention-popover-status-online' : 'mention-popover-status-offline'}`} aria-label={user.status === 'online' ? 'Online' : 'Offline'} /><span className="mention-popover-secondary">{getUserHandle(user)}{contextType === 'channel' && !contextMemberIds.includes(user._id) ? ' · Not in channel' : ''}</span></span></span>
      {index === activeIndex && <kbd className="mention-popover-hint">Enter</kbd>}
    </button>) : <div className="mention-popover-empty">No people found</div>}
  </div>, document.body);
}
