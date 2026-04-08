import { cn } from '@/lib/utils'

export function inputClass(isInherited?: boolean) {
  return cn(
    'w-36 rounded border border-[var(--border)] bg-[var(--bg-base)] px-2 py-1 text-xs focus:outline-none focus:border-[var(--accent)] transition-colors',
    isInherited
      ? 'text-[var(--text-muted)] placeholder:text-[var(--text-muted)]'
      : 'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]'
  )
}

export function selectClass() {
  return 'w-36 rounded border border-[var(--border)] bg-[var(--bg-base)] px-2 py-1 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors'
}
