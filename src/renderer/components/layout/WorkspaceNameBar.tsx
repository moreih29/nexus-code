import { X } from 'lucide-react'

interface WorkspaceNameBarProps {
  name: string
  onClose: () => void
}

export function WorkspaceNameBar({ name, onClose }: WorkspaceNameBarProps) {
  return (
    <div className="flex h-6 shrink-0 items-center justify-between border-b border-border bg-card px-2">
      <span className="text-xs font-medium text-muted-foreground">{name}</span>
      <button
        onClick={onClose}
        className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        title="분할 해제"
      >
        <X size={10} />
      </button>
    </div>
  )
}
