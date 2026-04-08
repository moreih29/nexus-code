import { Info } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { type CliSettings, type SettingsScope } from '@/stores/settings-store'
import { cn } from '@/lib/utils'
import { FieldRow } from '../components/field-row'
import { inputClass } from '../components/form-utils'

interface ClaudeCodeTabProps {
  scope: SettingsScope
  draftCli: CliSettings
  globalCliDraft: CliSettings
  projectCliSettings: Partial<CliSettings>
  permissionsText: string
  permissionsError: string
  onPermissionsTextChange: (text: string) => void
  onPermissionsBlur: () => void
  updateDraftCli: (scope: SettingsScope, settings: CliSettings) => void
}

export function ClaudeCodeTab({
  scope,
  draftCli,
  globalCliDraft,
  projectCliSettings,
  permissionsText,
  permissionsError,
  onPermissionsTextChange,
  onPermissionsBlur,
  updateDraftCli,
}: ClaudeCodeTabProps) {
  return (
    <section>
      <div className="flex items-start gap-1.5 mb-4 p-2.5 rounded bg-[var(--bg-base)] border border-[var(--border)]">
        <Info className="size-3.5 text-[var(--text-muted)] flex-shrink-0 mt-0.5" />
        <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
          이 설정은 Claude Code의 <span className="font-mono">settings.json</span>에 반영됩니다
        </p>
      </div>
      <div className="divide-y divide-[var(--border)]">

        {/* 확장 사고 */}
        <FieldRow
          label="확장 사고"
          onReset={scope === 'project' ? () => {
            const { alwaysThinkingEnabled: _, ...rest } = projectCliSettings as CliSettings
            updateDraftCli('project', rest)
          } : undefined}
          hasOverride={scope === 'project' && 'alwaysThinkingEnabled' in projectCliSettings}
        >
          <Switch
            checked={draftCli.alwaysThinkingEnabled ?? false}
            onCheckedChange={(checked) =>
              updateDraftCli(scope, { ...draftCli, alwaysThinkingEnabled: checked })
            }
          />
        </FieldRow>

        {/* 권한 룰 */}
        <div className="py-2">
          <div className="flex items-center mb-1.5">
            <span className="text-xs text-[var(--text-secondary)]">권한 룰</span>
          </div>
          <textarea
            rows={4}
            value={permissionsText}
            onChange={(e) => onPermissionsTextChange(e.target.value)}
            onBlur={onPermissionsBlur}
            placeholder={'{"allow": [], "deny": []}'}
            className={cn(
              'w-full rounded border bg-[var(--bg-base)] px-2 py-1.5 text-[10px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none resize-none transition-colors',
              permissionsError
                ? 'border-[var(--red)]'
                : 'border-[var(--border)] focus:border-[var(--accent)]'
            )}
          />
          {permissionsError && (
            <p className="text-[10px] text-[var(--red)] mt-1">{permissionsError}</p>
          )}
          <p className="text-[10px] text-[var(--text-muted)] mt-1">
            포커스 해제 시 적용. JSON 객체 형식.
          </p>
        </div>

        {/* 응답 언어 */}
        <FieldRow
          label="응답 언어"
          onReset={scope === 'project' ? () => {
            const { language: _, ...rest } = projectCliSettings as CliSettings
            updateDraftCli('project', rest)
          } : undefined}
          hasOverride={scope === 'project' && 'language' in projectCliSettings}
        >
          <input
            type="text"
            placeholder={
              scope === 'project' && globalCliDraft.language
                ? `${globalCliDraft.language} (전역)`
                : '예: ko, en'
            }
            value={draftCli.language ?? ''}
            onChange={(e) =>
              updateDraftCli(scope, { ...draftCli, language: e.target.value || undefined })
            }
            className={inputClass(scope === 'project' && !draftCli.language && !!globalCliDraft.language)}
          />
        </FieldRow>

      </div>
    </section>
  )
}
