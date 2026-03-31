import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useSettingsStore } from '../../stores/settings-store'
import type { ModelId } from '../../stores/settings-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { MODEL_ALIASES, getModelAlias } from '../../lib/models'

const EFFORT_LEVELS = ['auto', 'low', 'medium', 'high', 'max'] as const
type EffortLevel = (typeof EFFORT_LEVELS)[number]

const EFFORT_LABELS: Record<EffortLevel, string> = {
  auto: 'Auto',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
}

export function ModelSwitcher() {
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const effective = useSettingsStore((s) => s.effective)
  const updateSetting = useSettingsStore((s) => s.updateSetting)
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)

  const currentModel = useSettingsStore((s) => s.model)
  const currentEffort = effective.effortLevel

  const modelAlias = getModelAlias(currentModel ?? 'claude-sonnet-4-6')
  const effortLabel = currentEffort ? EFFORT_LABELS[currentEffort as EffortLevel] ?? currentEffort : null

  // 워크스페이스 활성 시 project scope, 미활성 시 global scope
  const scope = activeWorkspace ? 'project' : 'global'

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const handleModelSelect = (model: ModelId) => {
    updateSetting(scope, 'model', model)
  }

  const handleEffortSelect = (effort: EffortLevel) => {
    updateSetting(scope, 'effortLevel', effort)
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <span>
          {modelAlias}
          {effortLabel && (
            <span className="opacity-60"> · {effortLabel}</span>
          )}
        </span>
        <ChevronDown className="h-3 w-3 opacity-50" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1.5 w-52 overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
          {/* 모델 섹션 */}
          <div className="px-2 pb-1 pt-2">
            <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              모델
            </p>
            {(Object.entries(MODEL_ALIASES) as [ModelId, string][]).map(([model]) => (
              <button
                key={model}
                type="button"
                onClick={() => handleModelSelect(model)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
              >
                <span className="w-3.5">
                  {currentModel === model && <Check className="h-3.5 w-3.5 text-primary" />}
                </span>
                {getModelAlias(model)}
              </button>
            ))}
          </div>

          <div className="mx-2 my-1 h-px bg-border" />

          {/* Effort 섹션 */}
          <div className="px-2 pb-1">
            <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Effort
            </p>
            {EFFORT_LEVELS.map((effort) => (
              <button
                key={effort}
                type="button"
                onClick={() => handleEffortSelect(effort)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
              >
                <span className="w-3.5">
                  {currentEffort === effort && <Check className="h-3.5 w-3.5 text-primary" />}
                </span>
                {EFFORT_LABELS[effort]}
              </button>
            ))}
          </div>

          <div className="mx-2 my-1 h-px bg-border" />

          {/* 안내 텍스트 */}
          <p className="px-3 pb-2 pt-1 text-xs text-muted-foreground">
            {activeWorkspace ? '이 워크스페이스에만 적용' : '모든 워크스페이스에 적용'}
          </p>
        </div>
      )}
    </div>
  )
}
