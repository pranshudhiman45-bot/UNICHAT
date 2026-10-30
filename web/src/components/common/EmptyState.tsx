export default function EmptyState({ title, description }: { title: string; description?: string }) {
  return <div className="flex flex-col items-center justify-center px-6 py-16 text-center"><p className="text-sm font-medium text-slate-700">{title}</p>{description && <p className="mt-1 max-w-xs text-xs text-slate-400">{description}</p>}</div>;
}
