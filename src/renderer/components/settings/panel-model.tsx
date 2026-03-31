import type { ClaudeSettings } from '../../../shared/types'
import { AVAILABLE_MODELS, type ModelId } from '../../stores/settings-store'
import { Toggle, SectionLabel, INPUT_CLASS, SELECT_CLASS, OverrideToggle } from './settings-shared'
import type { Scope } from './settings-shared'
import { cn } from '../../lib/utils'

const EFFORT_LEVELS: { value: NonNullable<ClaudeSettings['effortLevel']>; label: string }[] = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'max', label: 'max' },
  { value: 'auto', label: 'auto' },
]

const TEAMMATE_MODES: { value: NonNullable<ClaudeSettings['teammateMode']>; label: string }[] = [
  { value: 'auto', label: 'auto' },
  { value: 'in-process', label: 'in-process' },
  { value: 'tmux', label: 'tmux' },
]

interface Props {
  scope: Scope
  global: Partial<ClaudeSettings>
  project: Partial<ClaudeSettings>
  effective: Partial<ClaudeSettings>
  onUpdate: (key: keyof ClaudeSettings, value: unknown) => void
  onReset: (key: string) => void
}

export function PanelModel({ scope, global: g, project, effective, onUpdate, onReset }: Props) {
  // 전역 뷰: global 값 표시/편집. 워크스페이스 뷰: effective 값 표시
  const source = scope === 'global' ? g : effective
  const model = source.model as ModelId | undefined
  const effortLevel = source.effortLevel ?? 'high'
  const language = source.language ?? ''
  const outputStyle = source.outputStyle ?? ''
  const teammateMode = source.teammateMode ?? 'auto'
  const alwaysThinkingEnabled = source.alwaysThinkingEnabled ?? false

  const isProject = scope === 'project'

  const handleOverrideToggle = (key: keyof ClaudeSettings, enabled: boolean, effectiveValue: unknown): void => {
    if (enabled) {
      onUpdate(key, effectiveValue)
    } else {
      onReset(key as string)
    }
  }

  const isOverridden = (key: keyof ClaudeSettings): boolean =>
    project[key] !== undefined && project[key] !== null

  const isEditable = (key: keyof ClaudeSettings): boolean =>
    !isProject || isOverridden(key)

  return (
    <div className="flex flex-col gap-6">
      {/* 모델 */}
      <section>
        <div className="flex items-center justify-between mb-1.5">
          <SectionLabel>모델</SectionLabel>
          {isProject && (
            <OverrideToggle
              settingKey="model"
              project={project}
              effectiveValue={model ?? 'claude-sonnet-4-6'}
              onToggle={handleOverrideToggle}
              onReset={onReset}
            />
          )}
        </div>
        {isEditable('model') ? (
          <select
            value={model ?? 'claude-sonnet-4-6'}
            onChange={(e) => onUpdate('model', e.target.value)}
            className={SELECT_CLASS}
          >
            {AVAILABLE_MODELS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        ) : (
          <div className={cn(SELECT_CLASS, 'text-muted-foreground')}>
            {String(g['model'] ?? 'claude-sonnet-4-6')}
          </div>
        )}
        <p className="mt-1 text-xs text-muted-foreground/70">다음 세션부터 적용됩니다</p>
      </section>

      {/* 처리 강도 */}
      <section>
        <div className="flex items-center justify-between mb-1.5">
          <SectionLabel>처리 강도</SectionLabel>
          {isProject && (
            <OverrideToggle
              settingKey="effortLevel"
              project={project}
              effectiveValue={effortLevel}
              onToggle={handleOverrideToggle}
              onReset={onReset}
            />
          )}
        </div>
        {isEditable('effortLevel') ? (
          <div className="flex flex-wrap gap-2">
            {EFFORT_LEVELS.map((level) => (
              <label key={level.value} className="flex cursor-pointer items-center gap-1.5 text-sm text-foreground">
                <input
                  type="radio"
                  name="effortLevel"
                  value={level.value}
                  checked={effortLevel === level.value}
                  onChange={(e) => onUpdate('effortLevel', e.target.value)}
                  className="accent-primary"
                />
                {level.label}
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{String(g.effortLevel ?? 'high')}</p>
        )}
        <p className="mt-1 text-xs text-muted-foreground/70">다음 세션부터 적용됩니다</p>
      </section>

      {/* 언어 */}
      <section>
        <div className="flex items-center justify-between mb-1.5">
          <SectionLabel>언어</SectionLabel>
          {isProject && (
            <OverrideToggle
              settingKey="language"
              project={project}
              effectiveValue={language}
              onToggle={handleOverrideToggle}
              onReset={onReset}
            />
          )}
        </div>
        {isEditable('language') ? (
          <input
            type="text"
            value={language}
            onChange={(e) => onUpdate('language', e.target.value || undefined)}
            placeholder="한글, English, ..."
            className={INPUT_CLASS}
          />
        ) : (
          <div className={cn(INPUT_CLASS, 'text-muted-foreground')}>
            {String(g.language ?? '')}
          </div>
        )}
      </section>

      {/* 출력 스타일 */}
      <section>
        <div className="flex items-center justify-between mb-1.5">
          <SectionLabel>출력 스타일</SectionLabel>
          {isProject && (
            <OverrideToggle
              settingKey="outputStyle"
              project={project}
              effectiveValue={outputStyle}
              onToggle={handleOverrideToggle}
              onReset={onReset}
            />
          )}
        </div>
        {isEditable('outputStyle') ? (
          <input
            type="text"
            value={outputStyle}
            onChange={(e) => onUpdate('outputStyle', e.target.value || undefined)}
            placeholder="concise, detailed, ..."
            className={INPUT_CLASS}
          />
        ) : (
          <div className={cn(INPUT_CLASS, 'text-muted-foreground')}>
            {String(g.outputStyle ?? '')}
          </div>
        )}
      </section>

      {/* 팀원 모드 */}
      <section>
        <div className="flex items-center justify-between mb-1.5">
          <SectionLabel>팀원 모드</SectionLabel>
          {isProject && (
            <OverrideToggle
              settingKey="teammateMode"
              project={project}
              effectiveValue={teammateMode}
              onToggle={handleOverrideToggle}
              onReset={onReset}
            />
          )}
        </div>
        {isEditable('teammateMode') ? (
          <div className="flex gap-4">
            {TEAMMATE_MODES.map((m) => (
              <label key={m.value} className="flex cursor-pointer items-center gap-1.5 text-sm text-foreground">
                <input
                  type="radio"
                  name="teammateMode"
                  value={m.value}
                  checked={teammateMode === m.value}
                  onChange={(e) => onUpdate('teammateMode', e.target.value)}
                  className="accent-primary"
                />
                {m.label}
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{String(g.teammateMode ?? 'auto')}</p>
        )}
      </section>

      {/* 항상 생각 모드 */}
      <section>
        <div className="flex items-center justify-between mb-1.5">
          <SectionLabel>항상 생각 모드</SectionLabel>
          {isProject && (
            <OverrideToggle
              settingKey="alwaysThinkingEnabled"
              project={project}
              effectiveValue={alwaysThinkingEnabled}
              onToggle={handleOverrideToggle}
              onReset={onReset}
            />
          )}
        </div>
        {isEditable('alwaysThinkingEnabled') ? (
          <label className="flex cursor-pointer items-center justify-between">
            <span className="text-sm text-foreground">Extended thinking 항상 활성화</span>
            <Toggle
              checked={alwaysThinkingEnabled}
              onChange={(v) => onUpdate('alwaysThinkingEnabled', v)}
            />
          </label>
        ) : (
          <p className="text-sm text-muted-foreground">{String(g.alwaysThinkingEnabled ?? false)}</p>
        )}
      </section>
    </div>
  )
}
