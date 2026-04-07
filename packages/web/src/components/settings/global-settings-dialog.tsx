import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { THEMES, useTheme } from '@/hooks/use-theme'
import {
  MODELS,
  useSettingsStore,
  type EffortLevel,
  type ModelId,
  type PermissionMode,
} from '@/stores/settings-store'
import { cn } from '@/lib/utils'

interface GlobalSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function GlobalSettingsDialog({ open, onOpenChange }: GlobalSettingsDialogProps) {
  const { theme, setTheme } = useTheme()
  const {
    defaultModel,
    defaultPermissionMode,
    defaultEffortLevel,
    defaultMaxTurns,
    setDefaultModel,
    setDefaultPermissionMode,
    setDefaultEffortLevel,
    setDefaultMaxTurns,
  } = useSettingsStore()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>전역 설정</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-5 py-2">
          {/* Theme */}
          <section>
            <label className="text-xs font-semibold text-[var(--text-muted)] mb-2 block uppercase tracking-wider">
              테마
            </label>
            <div className="grid grid-cols-4 gap-2">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTheme(t.id)}
                  className={cn(
                    'rounded px-2 py-1.5 text-xs border transition-colors text-left',
                    theme === t.id
                      ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]'
                      : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </section>

          {/* Default Model */}
          <section>
            <label className="text-xs font-semibold text-[var(--text-muted)] mb-2 block uppercase tracking-wider">
              기본 모델
            </label>
            <div className="flex gap-2">
              {MODELS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setDefaultModel(m.id as ModelId)}
                  className={cn(
                    'rounded px-3 py-1.5 text-xs border transition-colors',
                    defaultModel === m.id
                      ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]'
                      : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </section>

          {/* Permission Mode */}
          <section>
            <label className="text-xs font-semibold text-[var(--text-muted)] mb-2 block uppercase tracking-wider">
              기본 권한 모드
            </label>
            <div className="flex gap-2">
              {(
                [
                  { id: 'default', label: 'Default' },
                  { id: 'auto', label: 'Auto' },
                  { id: 'bypassPermissions', label: 'Bypass' },
                ] as { id: PermissionMode; label: string }[]
              ).map((m) => (
                <button
                  key={m.id}
                  onClick={() => setDefaultPermissionMode(m.id)}
                  className={cn(
                    'rounded px-3 py-1.5 text-xs border transition-colors',
                    defaultPermissionMode === m.id
                      ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]'
                      : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </section>

          {/* Effort Level */}
          <section>
            <label className="text-xs font-semibold text-[var(--text-muted)] mb-2 block uppercase tracking-wider">
              기본 Effort
            </label>
            <div className="flex gap-2">
              {(
                [
                  { id: 'low', label: 'Low' },
                  { id: 'medium', label: 'Medium' },
                  { id: 'high', label: 'High' },
                ] as { id: EffortLevel; label: string }[]
              ).map((e) => (
                <button
                  key={e.id}
                  onClick={() => setDefaultEffortLevel(e.id)}
                  className={cn(
                    'rounded px-3 py-1.5 text-xs border transition-colors',
                    defaultEffortLevel === e.id
                      ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]'
                      : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  )}
                >
                  {e.label}
                </button>
              ))}
            </div>
          </section>

          {/* Max Turns */}
          <section>
            <label className="text-xs font-semibold text-[var(--text-muted)] mb-2 block uppercase tracking-wider">
              최대 턴 수
            </label>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={1}
                placeholder="무한"
                value={defaultMaxTurns ?? ''}
                onChange={(e) => {
                  const val = e.target.value
                  setDefaultMaxTurns(val === '' ? null : parseInt(val, 10))
                }}
                className="w-24 rounded border border-[var(--border)] bg-[var(--bg-base)] px-2 py-1 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
              />
              {defaultMaxTurns !== null && (
                <button
                  onClick={() => setDefaultMaxTurns(null)}
                  className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  초기화
                </button>
              )}
              {defaultMaxTurns === null && (
                <span className="text-xs text-[var(--text-muted)]">무한</span>
              )}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
