export default function BrandMark({ size = 36 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true"><rect width="40" height="40" rx="12" fill="#611f69"/><path d="M11 12v10a9 9 0 0 0 18 0V12" stroke="white" strokeWidth="5" strokeLinecap="round"/><circle cx="29" cy="11" r="3" fill="#36c5f0"/><circle cx="11" cy="11" r="3" fill="#ecb22e"/></svg>;
}
