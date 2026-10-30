import { useEffect, useRef } from 'react';
import { Picker } from 'emoji-mart';
import data from '@emoji-mart/data';
export default function EmojiPickerPanel({ theme, onSelect }: { theme: 'light' | 'dark'; onSelect: (emoji: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const callback = useRef(onSelect); callback.current = onSelect;
  useEffect(() => {
    if (!host.current) return;
    const picker = new Picker({ data, theme, set: 'native', previewPosition: 'none', navPosition: 'top', skinTonePosition: 'search', onEmojiSelect: (selection: { native?: string }) => { if (selection.native) callback.current(selection.native); } });
    const element = picker as unknown as HTMLElement;
    host.current.appendChild(element);
    return () => element.remove();
  }, [theme]);
  return <div ref={host}/>;
}
