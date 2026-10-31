import type { ReactNode } from 'react';
import BrandMark from '../common/BrandMark';
import UiIcon from '../common/UiIcon';
import { useAuth } from '../../hooks/useAuth';

interface Props { title: string; subtitle: string; error?: string; children: ReactNode; footer: ReactNode; }
export default function AuthLayout({ title, subtitle, error, children, footer }: Props) {
  const { serverUnreachable } = useAuth();
  return <main className="auth-page"><div className="auth-frame">
    <aside className="auth-story" aria-label="Welcome to Unichat"><div className="flex items-center gap-3"><BrandMark size={40}/><span className="text-xl font-bold tracking-tight">Unichat</span></div>
      <div className="my-auto py-12"><span className="auth-eyebrow">A LITTLE LESS EMAIL. A LOT MORE TOGETHER.</span><h2 className="mt-5 text-4xl font-semibold leading-[1.15] tracking-tight">Good work starts<br/>with a conversation.</h2><p className="mt-5 max-w-sm text-base leading-7 text-white/70">Bring your people, ideas, and everyday moments into one shared space.</p>
        <div className="auth-preview mt-9" aria-hidden="true"><div className="flex items-center gap-2 border-b border-white/10 pb-3 text-sm font-semibold"><UiIcon name="hash"/> team-design<span className="ml-auto flex items-center gap-1.5 text-xs font-normal text-white/60"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400"/> Online</span></div><div className="mt-4 flex gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#e9c5a9] text-sm font-bold text-[#522b26]">A</span><div><p className="text-sm font-semibold">Alex <span className="ml-2 text-[10px] font-normal text-white/40">10:24 AM</span></p><p className="mt-1 text-sm leading-6 text-white/80">The new designs are ready. Let’s make something great together.</p><span className="mt-2 inline-flex items-center rounded-md border border-white/20 bg-white/10 px-2 py-1 text-xs">🙌 <span className="ml-1">3</span></span></div></div></div>
      </div><p className="text-xs text-white/50">Conversations. Connections. A place for your team.</p>
    </aside>
    <section className="auth-form-panel"><div className="mb-8 flex items-center gap-2.5 lg:hidden"><BrandMark/><span className="text-lg font-bold">Unichat</span></div><div className="w-full max-w-sm"><h1 className="text-[28px] font-semibold leading-tight tracking-tight text-[var(--text)]">{title}</h1><p className="mb-7 mt-3 text-sm leading-6 text-[var(--text-secondary)]">{subtitle}</p>{serverUnreachable && <div role="status" className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">Can’t reach the Unichat server right now. It may be starting up; retrying automatically.</div>}{error && <div className="mb-5 rounded-lg border border-[var(--error-border)] bg-[var(--error-surface)] px-4 py-3 text-sm text-[var(--error-text)]" role="alert">{error}</div>}{children}{footer}</div><p className="mt-10 text-center text-xs text-[var(--text-muted)]">Made for the way your team works.</p></section>
  </div></main>;
}
