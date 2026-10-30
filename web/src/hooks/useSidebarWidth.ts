import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

const STORAGE_KEY = 'unichat:sidebar-width';
const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 200;
const MAX_WIDTH = 420;

function maxWidth() {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - 460));
}

function clampWidth(value: number) {
  return Math.min(Math.max(value, MIN_WIDTH), maxWidth());
}

function savedWidth() {
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value >= MIN_WIDTH ? clampWidth(value) : clampWidth(DEFAULT_WIDTH);
  } catch { return clampWidth(DEFAULT_WIDTH); }
}

export function useSidebarWidth() {
  const [width, setWidth] = useState(savedWidth);
  const widthRef = useRef(width);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const applyWidth = (next: number, persist: boolean) => {
    const safe = clampWidth(next);
    widthRef.current = safe;
    rootRef.current?.style.setProperty('--workspace-sidebar-width', `${safe}px`);
    if (persist) {
      setWidth(safe);
      try { window.localStorage.setItem(STORAGE_KEY, String(safe)); } catch { /* Browser storage is optional. */ }
    }
  };

  useEffect(() => {
    const onResize = () => applyWidth(widthRef.current, true);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { startX: event.clientX, startWidth: widthRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
    rootRef.current?.setAttribute('data-resizing-sidebar', 'true');
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    applyWidth(dragRef.current.startWidth + event.clientX - dragRef.current.startX, false);
    event.currentTarget.setAttribute('aria-valuenow', String(widthRef.current));
  };
  const onPointerEnd = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    rootRef.current?.removeAttribute('data-resizing-sidebar');
    applyWidth(widthRef.current, true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 32 : 16;
    const next = event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? maxWidth()
      : widthRef.current + (event.key === 'ArrowRight' ? step : -step);
    applyWidth(next, true);
  };

  return { rootRef, width, minWidth: MIN_WIDTH, maxWidth: maxWidth(), onPointerDown, onPointerMove, onPointerEnd, onKeyDown, reset: () => applyWidth(DEFAULT_WIDTH, true) };
}
