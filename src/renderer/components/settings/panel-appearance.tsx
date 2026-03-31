import type { ClaudeSettings } from '../../../shared/types'
import { THEMES, type Theme, type ToolDensity } from '../../stores/settings-store'
import { Toggle, SectionLabel } from './settings-shared'
import type { Scope } from './settings-shared'
import { cn } from '../../lib/utils'

interface Props {
  scope: Scope
  theme: Theme
  toolDensity: ToolDensity
  notificationsEnabled: boolean
  effective: Partial<ClaudeSettings>
  global: Partial<ClaudeSettings>
  project: Partial<ClaudeSettings>
  onThemeChange: (theme: Theme) => void
  onToolDensityChange: (density: ToolDensity) => void
  onNotificationsChange: (v: boolean) => void
  onUpdate: (key: keyof ClaudeSettings, value: unknown) => void
  onReset: (key: string) => void
}

export function PanelAppearance({
  theme,
  toolDensity,
  notificationsEnabled,
  effective,
  onThemeChange,
  onToolDensityChange,
  onNotificationsChange,
  onUpdate,
}: Props) {
  const prefersReducedMotion = effective.prefersReducedMotion ?? false

  return (
    <div className="flex flex-col gap-6">
      {/* 테마 — 전역 전용 */}
      <section>
        <SectionLabel>테마</SectionLabel>
        <div className="grid grid-cols-3 gap-2">
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => onThemeChange(t.id)}
              className={cn(
                'flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                theme === t.id
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground',
              )}
            >
              <span className="flex gap-0.5">
                {t.swatches.map((color, i) => (
                  <span
                    key={i}
                    className="h-3 w-3 rounded-full border border-white/10"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </span>
              <span className="text-xs">{t.label}</span>
            </button>
          ))}
        </div>
      </section>

      {/* 도구 표시 밀도 — 전역 전용 */}
      <section>
        <SectionLabel>도구 표시 밀도</SectionLabel>
        <div className="flex gap-2">
          {(['compact', 'normal', 'verbose'] as ToolDensity[]).map((d) => (
            <button
              key={d}
              onClick={() => onToolDensityChange(d)}
              className={cn(
                'rounded-md border px-3 py-1.5 text-sm transition-colors',
                toolDensity === d
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground',
              )}
            >
              {d === 'compact' ? '간략' : d === 'normal' ? '보통' : '상세'}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground/70">
          간략: 완료된 도구를 한 줄로 · 보통: 접힘/펼침 · 상세: 결과 기본 펼침
        </p>
      </section>

      {/* 알림 — 전역 전용 */}
      <section>
        <SectionLabel>알림</SectionLabel>
        <label className="flex cursor-pointer items-center justify-between">
          <span className="text-sm text-foreground">완료/오류 시스템 알림</span>
          <Toggle checked={notificationsEnabled} onChange={onNotificationsChange} />
        </label>
      </section>

      {/* 모션 감소 — 전역 전용 */}
      <section>
        <SectionLabel>접근성</SectionLabel>
        <label className="flex cursor-pointer items-center justify-between">
          <span className="text-sm text-foreground">모션 줄이기</span>
          <Toggle
            checked={prefersReducedMotion}
            onChange={(v) => onUpdate('prefersReducedMotion', v)}
          />
        </label>
      </section>
    </div>
  )
}
