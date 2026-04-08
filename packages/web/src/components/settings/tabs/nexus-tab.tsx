import { RotateCcw } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { MODELS, type AppSettings, type SettingsScope } from '@/stores/settings-store'
import { cn } from '@/lib/utils'
import { FieldRow } from '../components/field-row'
import { TagInput } from '../components/tag-input'
import { DisallowedToolsInput } from '../components/disallowed-tools-input'
import { inputClass, selectClass } from '../components/form-utils'

interface NexusTabProps {
  scope: SettingsScope
  draft: AppSettings
  globalDraft: AppSettings
  projectSettings: Partial<AppSettings>
  autoSave: (partial: Partial<AppSettings>) => void
  updateDraft: (scope: SettingsScope, partial: Partial<AppSettings>) => void
  resetProjectKey: (key: keyof AppSettings) => void
}

export function NexusTab({
  scope,
  draft,
  globalDraft,
  projectSettings,
  autoSave,
  updateDraft,
  resetProjectKey,
}: NexusTabProps) {
  function getPlaceholder(key: keyof AppSettings): string | undefined {
    if (scope !== 'project') return undefined
    const globalVal = globalDraft[key]
    if (globalVal === undefined || globalVal === null) return undefined
    if (typeof globalVal === 'boolean') return globalVal ? '켜짐 (전역)' : '꺼짐 (전역)'
    if (Array.isArray(globalVal)) return globalVal.join(', ') + ' (전역)'
    return String(globalVal) + ' (전역)'
  }

  function hasProjectOverride(key: keyof AppSettings): boolean {
    if (scope !== 'project') return false
    return key in projectSettings
  }

  return (
    <section>
      <div className="divide-y divide-[var(--border)]">

        {/* 모델 */}
        <FieldRow
          label="모델"
          onReset={() => resetProjectKey('model')}
          hasOverride={hasProjectOverride('model')}
        >
          <select
            value={draft.model ?? (scope === 'global' ? 'sonnet' : '')}
            onChange={(e) => autoSave({ model: e.target.value || undefined })}
            className={selectClass()}
          >
            {scope === 'project' && (
              <option value="">
                {globalDraft.model
                  ? `${MODELS.find((m) => m.id === globalDraft.model)?.label ?? globalDraft.model} (전역)`
                  : 'Sonnet (전역)'}
              </option>
            )}
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </FieldRow>

        {/* 권한 모드 */}
        <FieldRow
          label="권한 모드"
          onReset={() => resetProjectKey('permissionMode')}
          hasOverride={hasProjectOverride('permissionMode')}
        >
          <div className="flex rounded bg-[var(--bg-base)] border border-[var(--border)] overflow-hidden">
            {([
              { id: 'default', label: 'Default' },
              { id: 'auto', label: 'Auto' },
              { id: 'bypassPermissions', label: 'Bypass' },
            ] as const).map((mode) => (
              <button
                key={mode.id}
                onClick={() => autoSave({ permissionMode: mode.id })}
                className={cn(
                  'px-2 py-1 text-[10px] font-medium transition-colors border-r border-[var(--border)] last:border-r-0',
                  (draft.permissionMode ?? 'default') === mode.id
                    ? 'bg-[var(--accent)] text-[var(--bg-base)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                )}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </FieldRow>

        {/* Effort */}
        <FieldRow
          label="Effort"
          onReset={() => resetProjectKey('effortLevel')}
          hasOverride={hasProjectOverride('effortLevel')}
        >
          <div className="flex rounded bg-[var(--bg-base)] border border-[var(--border)] overflow-hidden">
            {(['low', 'medium', 'high', 'max'] as const).map((level) => (
              <button
                key={level}
                onClick={() => autoSave({ effortLevel: level })}
                className={cn(
                  'px-2 py-1 text-[10px] font-medium transition-colors border-r border-[var(--border)] last:border-r-0',
                  (draft.effortLevel ?? 'medium') === level
                    ? 'bg-[var(--accent)] text-[var(--bg-base)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                )}
                title={level === 'max' ? '최대 비용 주의' : undefined}
              >
                {level === 'low' ? '낮음' : level === 'medium' ? '중간' : level === 'high' ? '높음' : '최대'}
              </button>
            ))}
          </div>
        </FieldRow>

        {/* 최대 턴 수 */}
        <FieldRow
          label="최대 턴 수"
          onReset={() => resetProjectKey('maxTurns')}
          hasOverride={hasProjectOverride('maxTurns')}
        >
          <input
            type="number"
            min={1}
            placeholder={getPlaceholder('maxTurns') ?? '무한'}
            value={draft.maxTurns ?? ''}
            onChange={(e) =>
              updateDraft(scope, {
                maxTurns: e.target.value ? parseInt(e.target.value, 10) : undefined,
              })
            }
            onBlur={() => autoSave({ maxTurns: draft.maxTurns })}
            className={inputClass(!draft.maxTurns && !!getPlaceholder('maxTurns'))}
          />
        </FieldRow>

        {/* 비용 상한 */}
        <div className="py-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center min-w-0">
              <span className="text-xs text-[var(--text-secondary)] whitespace-nowrap">비용 상한</span>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  placeholder={getPlaceholder('maxBudgetUsd') ?? '없음'}
                  value={draft.maxBudgetUsd ?? ''}
                  onChange={(e) =>
                    updateDraft(scope, {
                      maxBudgetUsd: e.target.value ? parseFloat(e.target.value) : undefined,
                    })
                  }
                  onBlur={() => autoSave({ maxBudgetUsd: draft.maxBudgetUsd })}
                  className={cn(inputClass(!draft.maxBudgetUsd && !!getPlaceholder('maxBudgetUsd')), 'w-28')}
                />
                <span className="text-[10px] text-[var(--text-muted)]">USD</span>
              </div>
              {hasProjectOverride('maxBudgetUsd') && (
                <button
                  onClick={() => resetProjectKey('maxBudgetUsd')}
                  title="전역 설정 사용"
                  className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--yellow)] transition-colors"
                >
                  <RotateCcw className="size-3" />
                </button>
              )}
            </div>
          </div>
          <p className="text-[10px] text-[var(--text-muted)] mt-1">
            API 키 사용 시에만 적용됩니다
          </p>
        </div>

        {/* 커스텀 지시사항 */}
        <div className="py-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-[var(--text-secondary)]">커스텀 지시사항</span>
            {scope === 'project' && hasProjectOverride('appendSystemPrompt') && (
              <button
                onClick={() => resetProjectKey('appendSystemPrompt')}
                title="전역 설정 사용"
                className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--yellow)] transition-colors"
              >
                <RotateCcw className="size-3" />
              </button>
            )}
          </div>
          <textarea
            rows={3}
            placeholder={
              scope === 'project' && globalDraft.appendSystemPrompt
                ? `${globalDraft.appendSystemPrompt} (전역)`
                : '추가 시스템 프롬프트...'
            }
            value={draft.appendSystemPrompt ?? ''}
            onChange={(e) =>
              updateDraft(scope, { appendSystemPrompt: e.target.value || undefined })
            }
            onBlur={() => autoSave({ appendSystemPrompt: draft.appendSystemPrompt })}
            className="w-full rounded border border-[var(--border)] bg-[var(--bg-base)] px-2 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] resize-none transition-colors"
          />
        </div>

        {/* 추가 디렉토리 */}
        <div className="py-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-[var(--text-secondary)]">추가 디렉토리</span>
            {scope === 'project' && hasProjectOverride('addDirs') && (
              <button
                onClick={() => resetProjectKey('addDirs')}
                title="전역 설정 사용"
                className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--yellow)] transition-colors"
              >
                <RotateCcw className="size-3" />
              </button>
            )}
          </div>
          <TagInput
            inputId="tag-add-dirs"
            values={draft.addDirs ?? []}
            onChange={(vals) => autoSave({ addDirs: vals.length > 0 ? vals : undefined })}
            placeholder="경로 추가..."
          />
          <p className="text-[10px] text-[var(--text-muted)] mt-1">
            Enter 또는 쉼표로 추가
          </p>
        </div>

        {/* 도구 차단 */}
        <div className="py-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-[var(--text-secondary)]">도구 차단</span>
            {scope === 'project' && hasProjectOverride('disallowedTools') && (
              <button
                onClick={() => resetProjectKey('disallowedTools')}
                title="전역 설정 사용"
                className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--yellow)] transition-colors"
              >
                <RotateCcw className="size-3" />
              </button>
            )}
          </div>
          <DisallowedToolsInput
            values={draft.disallowedTools ?? []}
            onChange={(vals) => autoSave({ disallowedTools: vals.length > 0 ? vals : undefined })}
          />
        </div>

        {/* 브라우저 자동화 */}
        <FieldRow
          label="브라우저 자동화"
          onReset={() => resetProjectKey('chromeEnabled')}
          hasOverride={hasProjectOverride('chromeEnabled')}
        >
          <Switch
            checked={draft.chromeEnabled ?? false}
            onCheckedChange={(checked) => autoSave({ chromeEnabled: checked })}
          />
        </FieldRow>

      </div>
    </section>
  )
}
