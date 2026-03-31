import { useState } from 'react'
import type { ClaudeSettings } from '../../../shared/types'
import { SectionLabel, OverrideToggle } from './settings-shared'
import type { Scope } from './settings-shared'

interface Props {
  scope: Scope
  global: Partial<ClaudeSettings>
  project: Partial<ClaudeSettings>
  effective: Partial<ClaudeSettings>
  onUpdate: (key: keyof ClaudeSettings, value: unknown) => void
  onReset: (key: string) => void
}

export function PanelPlugins({ scope, global: g, project, effective, onUpdate, onReset }: Props) {
  const source = scope === 'global' ? g : effective
  const enabledPlugins = source.enabledPlugins ?? {}
  const extraKnownMarketplaces = source.extraKnownMarketplaces
  const [marketplacesJson, setMarketplacesJson] = useState(
    extraKnownMarketplaces ? JSON.stringify(extraKnownMarketplaces, null, 2) : '',
  )
  const [jsonError, setJsonError] = useState(false)

  const knownPlugins = Object.keys(enabledPlugins)

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

  const handleMarketplacesChange = (val: string): void => {
    setMarketplacesJson(val)
    try {
      if (val.trim()) {
        const parsed = JSON.parse(val)
        setJsonError(false)
        onUpdate('extraKnownMarketplaces', parsed)
      } else {
        setJsonError(false)
        onUpdate('extraKnownMarketplaces', undefined)
      }
    } catch {
      setJsonError(true)
    }
  }

  const pluginsEditable = isEditable('enabledPlugins')
  const marketplacesEditable = isEditable('extraKnownMarketplaces')

  return (
    <div className="flex flex-col gap-6">
      {/* 플러그인 활성화 */}
      <section>
        <div className="flex items-center justify-between mb-1.5">
          <SectionLabel>플러그인</SectionLabel>
          {isProject && (
            <OverrideToggle
              settingKey="enabledPlugins"
              project={project}
              effectiveValue={enabledPlugins}
              onToggle={handleOverrideToggle}
              onReset={onReset}
            />
          )}
        </div>
        {knownPlugins.length === 0 ? (
          <p className="text-sm text-muted-foreground">등록된 플러그인이 없습니다.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {knownPlugins.map((id) => (
              <label key={id} className={pluginsEditable ? 'flex cursor-pointer items-center gap-2 text-sm text-foreground' : 'flex items-center gap-2 text-sm text-muted-foreground'}>
                <input
                  type="checkbox"
                  checked={!!enabledPlugins[id]}
                  readOnly={!pluginsEditable}
                  onChange={pluginsEditable ? () =>
                    onUpdate('enabledPlugins', { ...enabledPlugins, [id]: !enabledPlugins[id] })
                    : undefined}
                  className="accent-primary"
                />
                {id}
              </label>
            ))}
          </div>
        )}
      </section>

      {/* 추가 마켓플레이스 */}
      <section>
        <div className="flex items-center justify-between mb-1.5">
          <SectionLabel>추가 마켓플레이스 (JSON)</SectionLabel>
          {isProject && (
            <OverrideToggle
              settingKey="extraKnownMarketplaces"
              project={project}
              effectiveValue={effective.extraKnownMarketplaces ?? {}}
              onToggle={handleOverrideToggle}
              onReset={onReset}
            />
          )}
        </div>
        {marketplacesEditable ? (
          <>
            <textarea
              value={marketplacesJson}
              onChange={(e) => handleMarketplacesChange(e.target.value)}
              rows={6}
              spellCheck={false}
              className={`w-full rounded-md border ${jsonError ? 'border-destructive' : 'border-border'} bg-muted px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-ring focus:outline-none`}
              placeholder={'{\n  "mymarket": { "source": { ... } }\n}'}
            />
            {jsonError && <p className="mt-1 text-xs text-destructive">JSON 형식 오류</p>}
          </>
        ) : (
          <p className="text-xs text-muted-foreground/70">미설정</p>
        )}
      </section>
    </div>
  )
}
