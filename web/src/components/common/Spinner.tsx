export default function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <span className="text-xs text-slate-400">{label}</span>;
}
