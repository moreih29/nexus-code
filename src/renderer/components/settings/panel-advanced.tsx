import { useState } from 'react'
import type { ClaudeSettings } from '../../../shared/types'
import { Toggle, SectionLabel, OverrideToggle } from './settings-shared'
import type { Scope } from './settings-shared'

interface Props {
  scope: Scope
  global: Partial<ClaudeSettings>
  project: Partial<ClaudeSettings>
  effective: Partial<ClaudeSettings>
  onUpdate: (key: keyof ClaudeSettings, value: unknown) => void
  onReset: (key: string) => void
}

export function PanelAdvanced({ scope, global: g, project, effective, onUpdate, onReset }: Props) {
  const source = scope === 'global' ? g : effective
  const statusLine = source.statusLine
  const includeGitInstructions = source.includeGitInstructions ?? false
  const cleanupPeriodDays = source.cleanupPeriodDays ?? 30

  const [statusLineJson, setStatusLineJson] = useState(
    statusLine ? JSON.stringify(statusLine, null, 2) : '',
  )
  const [jsonError, setJsonError] = useState(false)

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

  const handleStatusLineChange = (val: string): void => {
    setStatusLineJson(val)
    try {
      if (val.trim()) {
        const parsed = JSON.parse(val)
        setJsonError(false)
        onUpdate('statusLine', parsed)
      } else {
        setJsonError(false)
        onUpdate('statusLine', undefined)
      }
    } catch {
      setJsonError(true)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* 상태표시줄 */}
      <section>
        <div className="flex items-center justify-between mb-1.5">
          <SectionLabel>상태표시줄 (JSON)</SectionLabel>
          {isProject && (
            <OverrideToggle
              settingKey="statusLine"
              project={project}
              effectiveValue={effective.statusLine ?? null}
              onToggle={handleOverrideToggle}
              onReset={onReset}
            />
          )}
        </div>
        {isEditable('statusLine') ? (
          <>
            <textarea
              value={statusLineJson}
              onChange={(e) => handleStatusLineChange(e.target.value)}
              rows={4}
              spellCheck={false}
              className={`w-full rounded-md border ${jsonError ? 'border-destructive' : 'border-border'} bg-muted px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-ring focus:outline-none`}
              placeholder={'{\n  "type": "command",\n  "command": "..."\n}'}
            />
            {jsonError && <p className="mt-1 text-xs text-destructive">JSON 형식 오류</p>}
          </>
        ) : (
          <p className="text-xs text-muted-foreground/70">미설정</p>
        )}
      </section>

      {/* Git 지침 포함 */}
      <section>
        <div className="flex items-center justify-between mb-1.5">
          <SectionLabel>Git 지침</SectionLabel>
          {isProject && (
            <OverrideToggle
              settingKey="includeGitInstructions"
              project={project}
              effectiveValue={includeGitInstructions}
              onToggle={handleOverrideToggle}
              onReset={onReset}
            />
          )}
        </div>
        {isEditable('includeGitInstructions') ? (
          <label className="flex cursor-pointer items-center justify-between">
            <span className="text-sm text-foreground">Git 지침 포함</span>
            <Toggle
              checked={includeGitInstructions}
              onChange={(v) => onUpdate('includeGitInstructions', v)}
            />
          </label>
        ) : (
          <label className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Git 지침 포함</span>
          </label>
        )}
      </section>

      {/* 정리 주기 */}
      <section>
        <div className="flex items-center justify-between mb-1.5">
          <SectionLabel>정리 주기 (일)</SectionLabel>
          {isProject && (
            <OverrideToggle
              settingKey="cleanupPeriodDays"
              project={project}
              effectiveValue={cleanupPeriodDays}
              onToggle={handleOverrideToggle}
              onReset={onReset}
            />
          )}
        </div>
        {isEditable('cleanupPeriodDays') ? (
          <input
            type="number"
            value={cleanupPeriodDays}
            onChange={(e) => onUpdate('cleanupPeriodDays', Number(e.target.value))}
            min={1}
            max={365}
            className="w-32 rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none"
          />
        ) : (
          <p className="text-sm text-muted-foreground">{String(g.cleanupPeriodDays ?? 30)}일</p>
        )}
      </section>
    </div>
  )
}
