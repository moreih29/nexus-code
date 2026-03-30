import { Plus } from 'lucide-react'
import { useActiveSession } from '../../stores/session-store'
import { useHistoryStore } from '../../stores/history-store'

export function NewSessionButton() {
  const reset = useActiveSession((s) => s.reset)
  const setActiveSessionId = useHistoryStore((s) => s.setActiveSessionId)

  const handleClick = (): void => {
    reset()
    setActiveSessionId(null)
  }

  return (
    <button
      onClick={handleClick}
      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Plus size={14} />
      <span>새 세션</span>
    </button>
  )
}
