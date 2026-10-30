import type { RefObject } from 'react';
import FloatingEmojiPicker from '../emoji/FloatingEmojiPicker';

interface Props {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  className?: string;
}

export default function ReactionPicker({ onSelect, onClose, anchorRef, className = '' }: Props) {
  return <FloatingEmojiPicker open anchorRef={anchorRef} onSelect={onSelect} onClose={onClose} className={className} />;
}

