import { cn } from '@/lib/utils'
import { type SettingsScope } from '@/stores/settings-store'

interface ScopeToggleProps {
  scope: SettingsScope
  setScope: (scope: SettingsScope) => void
  workspacePath: string | null | undefined
  workspaceName: string | null
}

export function ScopeToggle({ scope, setScope, workspacePath, workspaceName }: ScopeToggleProps) {
  return (
    <div className="px-5 pt-3 pb-3 border-b border-[var(--border)] flex-shrink-0">
      <div className="flex rounded-md bg-[var(--bg-base)] p-0.5 gap-0.5">
        <button
          onClick={() => setScope('global')}
          className={cn(
            'flex-1 rounded px-2 py-1 text-xs font-medium transition-colors',
            scope === 'global'
              ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-sm'
              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
          )}
        >
          전역
        </button>
        <button
          onClick={() => workspacePath && setScope('project')}
          disabled={!workspacePath}
          className={cn(
            'flex-1 rounded px-2 py-1 text-xs font-medium transition-colors truncate',
            scope === 'project'
              ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-sm'
              : workspacePath
                ? 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                : 'text-[var(--text-muted)] opacity-40 cursor-not-allowed'
          )}
          title={workspaceName ? `프로젝트: ${workspaceName}` : '워크스페이스를 먼저 선택하세요'}
        >
          {workspaceName ? `프로젝트: ${workspaceName}` : '프로젝트'}
        </button>
      </div>
    </div>
  )
}
