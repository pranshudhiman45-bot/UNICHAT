import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../../hooks/useTheme';

const EmojiPickerPanel = lazy(() => import('./EmojiPickerPanel'));

interface Props {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onSelect: (emoji: string) => void;
  onClose: () => void;
  className?: string;
}

interface Position {
  top: number;
  left: number;
}

const VIEWPORT_GAP = 8;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export default function FloatingEmojiPicker({ anchorRef, open, onSelect, onClose, className = '' }: Props) {
  const { resolvedTheme } = useTheme();
  const pickerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return undefined;
    }

    const updatePosition = () => {
      const anchor = anchorRef.current;
      const picker = pickerRef.current;
      if (!anchor) return;
      const anchorRect = anchor.getBoundingClientRect();
      const pickerRect = picker?.getBoundingClientRect();
      const pickerWidth = Math.min(pickerRect?.width || 352, window.innerWidth - (VIEWPORT_GAP * 2));
      const pickerHeight = Math.min(pickerRect?.height || 435, window.innerHeight - (VIEWPORT_GAP * 2));
      const roomBelow = window.innerHeight - anchorRect.bottom - VIEWPORT_GAP;
      const roomAbove = anchorRect.top - VIEWPORT_GAP;
      const opensAbove = roomBelow < pickerHeight && roomAbove > roomBelow;
      const top = opensAbove ? anchorRect.top - pickerHeight - VIEWPORT_GAP : anchorRect.bottom + VIEWPORT_GAP;
      const left = clamp(anchorRect.left, VIEWPORT_GAP, window.innerWidth - pickerWidth - VIEWPORT_GAP);
      setPosition({
        top: clamp(top, VIEWPORT_GAP, window.innerHeight - pickerHeight - VIEWPORT_GAP),
        left,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updatePosition) : undefined;
    if (pickerRef.current) resizeObserver?.observe(pickerRef.current);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      resizeObserver?.disconnect();
    };
  }, [anchorRef, open]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!pickerRef.current?.contains(target) && !anchorRef.current?.contains(target)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [anchorRef, onClose, open]);

  if (!open) return null;
  return createPortal(
    <div ref={pickerRef} className={`emoji-picker-portal ${className}`} style={{ top: position?.top ?? VIEWPORT_GAP, left: position?.left ?? VIEWPORT_GAP, visibility: position ? 'visible' : 'hidden' }} role="dialog" aria-label="Emoji picker">
      <Suspense fallback={<div className="emoji-picker-loading">Loading emojis…</div>}>
        <EmojiPickerPanel theme={resolvedTheme} onSelect={onSelect} />
      </Suspense>
    </div>,
    document.body,
  );
}
