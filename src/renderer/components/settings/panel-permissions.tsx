import { useState } from 'react'
import type { ClaudeSettings } from '../../../shared/types'
import { Toggle, SectionLabel, TagList, OverrideToggle } from './settings-shared'
import type { Scope } from './settings-shared'
import { ConfirmDialog } from '../ui/confirm-dialog'
import { cn } from '../../lib/utils'

const PERMISSION_MODES = [
  { value: 'default', label: '기본', description: '각 도구 사용마다 허용 여부를 묻습니다' },
  { value: 'acceptEdits', label: '편집 자동 허용', description: '파일 편집은 자동 허용, 나머지는 확인' },
  { value: 'plan', label: '계획 모드', description: '실행 전 계획만 수립, 직접 수행 안 함' },
  { value: 'dontAsk', label: '묻지 않기', description: '모든 도구를 확인 없이 실행합니다' },
  { value: 'auto', label: '자동', description: '안전한 작업은 자동, 위험 작업은 확인' },
  { value: 'bypassPermissions', label: '권한 검사 건너뛰기', description: '모든 권한 검사를 생략합니다 (위험)' },
]

const DANGEROUS_MODES = new Set(['bypassPermissions', 'auto', 'dontAsk'])

interface Props {
  scope: Scope
  global: Partial<ClaudeSettings>
  project: Partial<ClaudeSettings>
  effective: Partial<ClaudeSettings>
  onUpdate: (key: keyof ClaudeSettings, value: unknown) => void
  onReset: (key: string) => void
}

export function PanelPermissions({ scope, global: g, project, effective, onUpdate, onReset }: Props) {
  const [pendingMode, setPendingMode] = useState<string | null>(null)

  const source = scope === 'global' ? g : effective
  const permissions = source.permissions ?? {}
  const permissionMode = permissions.defaultMode ?? 'default'
  const allowList = permissions.allow ?? []
  const denyList = permissions.deny ?? []
  const skipDangerousPrompt = source.skipDangerousModePermissionPrompt ?? false
  const sandboxEnabled = source.sandbox?.enabled ?? false

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

  const handlePermissionModeChange = (newMode: string): void => {
    if (DANGEROUS_MODES.has(newMode)) {
      setPendingMode(newMode)
    } else {
      const updated = { ...permissions, defaultMode: newMode }
      onUpdate('permissions', updated)
    }
  }

  const confirmModeChange = (): void => {
    if (pendingMode) {
      const updated = { ...permissions, defaultMode: pendingMode }
      onUpdate('permissions', updated)
      setPendingMode(null)
    }
  }

  const updateAllowList = (list: string[]): void => {
    onUpdate('permissions', { ...permissions, allow: list })
  }

  const updateDenyList = (list: string[]): void => {
    onUpdate('permissions', { ...permissions, deny: list })
  }

  const permissionsEditable = isEditable('permissions')

  return (
    <div className="flex flex-col gap-6">
      {/* 퍼미션 모드 */}
      <section>
        <div className="flex items-center justify-between mb-1.5">
          <SectionLabel>퍼미션 모드</SectionLabel>
          {isProject && (
            <OverrideToggle
              settingKey="permissions"
              project={project}
              effectiveValue={effective.permissions ?? {}}
              onToggle={handleOverrideToggle}
              onReset={onReset}
            />
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {PERMISSION_MODES.map((m) => {
            const isSelected = permissionMode === m.value
            const isDangerous = DANGEROUS_MODES.has(m.value)
            return (
              <button
                key={m.value}
                type="button"
                disabled={!permissionsEditable}
                onClick={() => permissionsEditable && handlePermissionModeChange(m.value)}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
                  isSelected
                    ? isDangerous
                      ? 'border-warning/60 bg-warning/10 text-foreground'
                      : 'border-primary/60 bg-primary/10 text-foreground'
                    : 'border-border bg-card text-foreground hover:border-border/80 hover:bg-muted/50',
                  !permissionsEditable && 'cursor-not-allowed opacity-50',
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'h-3 w-3 rounded-full border-2 transition-colors',
                      isSelected
                        ? isDangerous
                          ? 'border-warning bg-warning'
                          : 'border-primary bg-primary'
                        : 'border-muted-foreground bg-transparent',
                    )}
                  />
                  <span className={cn('text-sm font-medium', isDangerous && isSelected && 'text-warning')}>
                    {m.label}
                  </span>
                </div>
                <p className="ml-4.5 text-xs text-muted-foreground leading-tight">{m.description}</p>
              </button>
            )
          })}
        </div>
        {!permissionsEditable && (
          <p className="mt-1 text-xs text-muted-foreground">
            현재 값: {PERMISSION_MODES.find((m) => m.value === (g.permissions?.defaultMode ?? 'default'))?.label ?? '기본'}
          </p>
        )}
      </section>

      {/* 허용 도구 */}
      <section>
        <SectionLabel>허용 도구</SectionLabel>
        <TagList
          items={allowList}
          onRemove={(idx) => updateAllowList(allowList.filter((_, i) => i !== idx))}
          onAdd={(v) => updateAllowList([...allowList, v])}
          placeholder="Bash(bun run:*)"
          disabled={!permissionsEditable}
        />
      </section>

      {/* 차단 도구 */}
      <section>
        <SectionLabel>차단 도구</SectionLabel>
        <TagList
          items={denyList}
          onRemove={(idx) => updateDenyList(denyList.filter((_, i) => i !== idx))}
          onAdd={(v) => updateDenyList([...denyList, v])}
          placeholder="Read(**/.venv/**)"
          disabled={!permissionsEditable}
        />
      </section>

      {/* 위험 모드 확인 생략 */}
      <section>
        <div className="flex items-center justify-between mb-1.5">
          <SectionLabel>기타 옵션</SectionLabel>
          {isProject && (
            <OverrideToggle
              settingKey="skipDangerousModePermissionPrompt"
              project={project}
              effectiveValue={skipDangerousPrompt}
              onToggle={handleOverrideToggle}
              onReset={onReset}
            />
          )}
        </div>
        <div className="flex flex-col gap-3">
          {isEditable('skipDangerousModePermissionPrompt') ? (
            <label className="flex cursor-pointer items-center justify-between">
              <span className="text-sm text-foreground">위험 모드 확인 생략</span>
              <Toggle
                checked={skipDangerousPrompt}
                onChange={(v) => onUpdate('skipDangerousModePermissionPrompt', v)}
              />
            </label>
          ) : (
            <label className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">위험 모드 확인 생략</span>
            </label>
          )}

          {/* 샌드박스 */}
          <div className="flex items-center justify-between">
            <SectionLabel>샌드박스</SectionLabel>
            {isProject && (
              <OverrideToggle
                settingKey="sandbox"
                project={project}
                effectiveValue={effective.sandbox ?? { enabled: false }}
                onToggle={handleOverrideToggle}
                onReset={onReset}
              />
            )}
          </div>
          {isEditable('sandbox') ? (
            <label className="flex cursor-pointer items-center justify-between">
              <span className="text-sm text-foreground">샌드박스 모드 활성화</span>
              <Toggle
                checked={sandboxEnabled}
                onChange={(v) => onUpdate('sandbox', { enabled: v })}
              />
            </label>
          ) : (
            <label className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">샌드박스 모드 활성화</span>
            </label>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={pendingMode !== null}
        onConfirm={confirmModeChange}
        onCancel={() => setPendingMode(null)}
        title="퍼미션 모드 변경"
        description={`"${PERMISSION_MODES.find((m) => m.value === pendingMode)?.label}" 모드로 변경하시겠습니까?`}
        detail="이 모드는 위험한 작업을 허용할 수 있습니다."
        confirmLabel="변경"
        variant="destructive"
      />
    </div>
  )
}
