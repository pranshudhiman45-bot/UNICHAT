export type IconName = 'search' | 'bell' | 'menu' | 'chevronDown' | 'chevronLeft' | 'chevronRight' | 'activity' | 'bookmark' | 'grid' | 'layers' | 'shield' | 'users' | 'lock' | 'hash' | 'plus' | 'mute' | 'file' | 'pin' | 'send' | 'close';

// One cohesive family: 24px grid, 1.6px round-cap strokes, drawn to read as refined at 14-20px.
export default function UiIcon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {name === 'search' && <><circle cx="11" cy="11" r="7" /><path d="m20.5 20.5-4.3-4.3" /></>}
    {name === 'bell' && <><path d="M6 9a6 6 0 0 1 12 0c0 6.5 2.5 8 2.5 8h-17S6 15.5 6 9Z" /><path d="M10.2 20.5a2 2 0 0 0 3.6 0" /></>}
    {name === 'menu' && <path d="M4 6.5h16M4 12h16M4 17.5h16" />}
    {name === 'chevronDown' && <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />}
    {name === 'chevronLeft' && <path d="m14.5 6-6 6 6 6" />}
    {name === 'chevronRight' && <path d="m9.5 6 6 6-6 6" />}
    {name === 'activity' && <path d="M20.5 15a2 2 0 0 1-2 2H8l-4.5 3.5V6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2Z" />}
    {name === 'bookmark' && <path d="m18.5 20.5-6.5-4-6.5 4V5.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2Z" />}
    {name === 'grid' && <><rect x="3.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.6" /></>}
    {name === 'layers' && <><path d="m12 3 9 4.8-9 4.8-9-4.8Z" /><path d="m3 12.2 9 4.8 9-4.8" /><path d="m3 16.6 9 4.8 9-4.8" /></>}
    {name === 'shield' && <><path d="M12 21.5s7.5-3.6 7.5-9.6V5.6L12 2.8 4.5 5.6v6.3c0 6 7.5 9.6 7.5 9.6Z" /><path d="m8.8 12 2.2 2.2 4.2-4.4" /></>}
    {name === 'users' && <><circle cx="9" cy="8" r="3.6" /><path d="M2.5 20.5v-1.2A5 5 0 0 1 7.5 14.3h3a5 5 0 0 1 5 5v1.2" /><path d="M16 4.6a3.6 3.6 0 0 1 0 6.8M21.5 20.5v-1.2a5 5 0 0 0-3.4-4.7" /></>}
    {name === 'lock' && <><rect x="4.5" y="10.5" width="15" height="10.5" rx="2.4" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></>}
    {name === 'hash' && <path d="M5 9h15M4 15h15M10.5 3.5 8.5 20.5M15.5 3.5l-2 17" />}
    {name === 'plus' && <path d="M12 5v14M5 12h14" />}
    {name === 'mute' && <><path d="M11 5 6.5 9H3v6h3.5L11 19Z" /><path d="m16 9.5 5 5M21 9.5l-5 5" /></>}
    {name === 'file' && <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>}
    {name === 'pin' && <><path d="M12 16.5V22" /><path d="M8.5 3.5h7l-.8 6 3.3 3v2.5H6V12.5l3.3-3Z" /></>}
    {name === 'send' && <><path d="M21.5 3 10.5 14" /><path d="m21.5 3-6.8 18.5-4.2-7.5L3 9.8Z" /></>}
    {name === 'close' && <path d="m6 6 12 12M18 6 6 18" />}
  </svg>;
}
