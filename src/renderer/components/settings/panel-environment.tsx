import type { ClaudeSettings } from '../../../shared/types'
import { Toggle, SectionLabel, EnvEditor, INPUT_CLASS, OverrideToggle } from './settings-shared'
import type { Scope } from './settings-shared'
import { cn } from '../../lib/utils'

interface Props {
  scope: Scope
  global: Partial<ClaudeSettings>
  project: Partial<ClaudeSettings>
  effective: Partial<ClaudeSettings>
  onUpdate: (key: keyof ClaudeSettings, value: unknown) => void
  onReset: (key: string) => void
}

export function PanelEnvironment({ scope, global: g, project, effective, onUpdate, onReset }: Props) {
  const source = scope === 'global' ? g : effective
  const env = source.env ?? {}
  const autoMemoryEnabled = source.autoMemoryEnabled ?? false
  const defaultShell = source.defaultShell ?? ''

  const isProject = scope === 'project'

  const isOverridden = (key: keyof ClaudeSettings): boolean =>
    project[key] !== undefined && project[key] !== null

  const isEditable = (key: keyof ClaudeSettings): boolean =>
    !isProject || isOverridden(key)

  const handleOverrideToggle = (key: keyof ClaudeSettings, enabled: boolean, effectiveValue: unknown): void => {
    if (enabled) {
      onUpdate(key, effectiveValue)
    } else {
      onReset(key as string)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* 환경 변수 */}
      <section>
        <div className="flex items-center justify-between mb-1.5">
          <SectionLabel>환경 변수 (env)</SectionLabel>
          {isProject && (
            <OverrideToggle
              settingKey="env"
              project={project}
              effectiveValue={env}
              onToggle={handleOverrideToggle}
              onReset={onReset}
            />
          )}
        </div>
        <EnvEditor
          env={env}
          onChange={(newEnv) => onUpdate('env', newEnv)}
          disabled={!isEditable('env')}
        />
      </section>

      {/* 자동 메모리 */}
      <section>
        <div className="flex items-center justify-between mb-1.5">
          <SectionLabel>자동 메모리</SectionLabel>
          {isProject && (
            <OverrideToggle
              settingKey="autoMemoryEnabled"
              project={project}
              effectiveValue={autoMemoryEnabled}
              onToggle={handleOverrideToggle}
              onReset={onReset}
            />
          )}
        </div>
        {isEditable('autoMemoryEnabled') ? (
          <label className="flex cursor-pointer items-center justify-between">
            <span className="text-sm text-foreground">자동 메모리 활성화</span>
            <Toggle
              checked={autoMemoryEnabled}
              onChange={(v) => onUpdate('autoMemoryEnabled', v)}
            />
          </label>
        ) : (
          <label className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">자동 메모리 활성화</span>
          </label>
        )}
      </section>

      {/* 기본 쉘 */}
      <section>
        <div className="flex items-center justify-between mb-1.5">
          <SectionLabel>기본 쉘</SectionLabel>
          {isProject && (
            <OverrideToggle
              settingKey="defaultShell"
              project={project}
              effectiveValue={defaultShell}
              onToggle={handleOverrideToggle}
              onReset={onReset}
            />
          )}
        </div>
        {isEditable('defaultShell') ? (
          <input
            type="text"
            value={defaultShell}
            onChange={(e) => onUpdate('defaultShell', e.target.value || undefined)}
            placeholder="/bin/zsh"
            className={INPUT_CLASS}
          />
        ) : (
          <div className={cn(INPUT_CLASS, 'text-muted-foreground')}>
            {String(g.defaultShell ?? '')}
          </div>
        )}
      </section>
    </div>
  )
}
