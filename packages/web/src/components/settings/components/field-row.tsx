import { RotateCcw } from 'lucide-react'

export function FieldRow({
  label,
  children,
  onReset,
  hasOverride,
}: {
  label: string
  children: React.ReactNode
  onReset?: () => void
  hasOverride?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="flex items-center min-w-0">
        <span className="text-xs text-[var(--text-secondary)] whitespace-nowrap">{label}</span>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {children}
        {onReset && hasOverride && (
          <button
            onClick={onReset}
            title="전역 설정 사용"
            className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--yellow)] transition-colors"
          >
            <RotateCcw className="size-3" />
          </button>
        )}
      </div>
    </div>
  )
}
