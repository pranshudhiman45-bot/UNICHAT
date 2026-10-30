import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

type Placement = 'top' | 'bottom';

interface Props {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  placement?: Placement;
  gap?: number;
  fallbackWidth?: number;
  fallbackHeight?: number;
  ariaLabel: string;
}

interface Position {
  top: number;
  left: number;
}

const VIEWPORT_GAP = 8;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export default function FloatingMenu({ anchorRef, open, onClose, children, className = '', placement = 'top', gap = 6, fallbackWidth = 240, fallbackHeight = 120, ariaLabel }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return undefined;
    }

    const updatePosition = () => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (!anchor) return;
      const anchorRect = anchor.getBoundingClientRect();
      const menuRect = menu?.getBoundingClientRect();
      const width = Math.min(menuRect?.width || fallbackWidth, window.innerWidth - (VIEWPORT_GAP * 2));
      const height = Math.min(menuRect?.height || fallbackHeight, window.innerHeight - (VIEWPORT_GAP * 2));
      const spaceAbove = anchorRect.top - gap - VIEWPORT_GAP;
      const spaceBelow = window.innerHeight - anchorRect.bottom - gap - VIEWPORT_GAP;
      const opensAbove = placement === 'top'
        ? spaceAbove >= height || spaceBelow < height
        : spaceBelow < height && spaceAbove >= spaceBelow;
      const top = opensAbove ? anchorRect.top - height - gap : anchorRect.bottom + gap;
      const left = clamp(anchorRect.left, VIEWPORT_GAP, window.innerWidth - width - VIEWPORT_GAP);
      setPosition({
        top: clamp(top, VIEWPORT_GAP, window.innerHeight - height - VIEWPORT_GAP),
        left,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updatePosition) : undefined;
    if (menuRef.current) resizeObserver?.observe(menuRef.current);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      resizeObserver?.disconnect();
    };
  }, [anchorRef, fallbackHeight, fallbackWidth, gap, open, placement]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !anchorRef.current?.contains(target)) onClose();
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
    <div ref={menuRef} className={`floating-menu ${className}`} style={{ top: position?.top ?? VIEWPORT_GAP, left: position?.left ?? VIEWPORT_GAP, visibility: position ? 'visible' : 'hidden' }} role="menu" aria-label={ariaLabel}>
      {children}
    </div>,
    document.body,
  );
}
