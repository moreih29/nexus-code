import { useState } from 'react'
import { X, Plus, Trash2, RotateCcw } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ClaudeSettings } from '../../../shared/types'

export interface OverrideToggleProps {
  settingKey: keyof ClaudeSettings
  project: Partial<ClaudeSettings>
  effectiveValue: unknown
  onToggle: (key: keyof ClaudeSettings, enabled: boolean, effectiveValue: unknown) => void
  onReset: (key: string) => void
}

export function OverrideToggle({
  settingKey,
  project,
  effectiveValue,
  onToggle,
  onReset,
}: OverrideToggleProps) {
  const isEnabled = project[settingKey] !== undefined && project[settingKey] !== null

  return (
    <div className="flex items-center gap-1.5">
      {isEnabled && (
        <button
          onClick={() => {
            onReset(settingKey as string)
          }}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RotateCcw size={10} />
          초기화
        </button>
      )}
      <button
        type="button"
        onClick={() => onToggle(settingKey, !isEnabled, effectiveValue)}
        className={cn(
          'relative inline-flex h-4 w-8 shrink-0 cursor-pointer rounded-full transition-colors',
          isEnabled ? 'bg-primary' : 'bg-muted border border-border',
        )}
        title={isEnabled ? '오버라이드 해제' : '오버라이드'}
      >
        <span
          className={cn(
            'inline-block h-3 w-3 translate-y-0.5 rounded-full bg-white shadow transition-transform',
            isEnabled ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </button>
      <span className="text-xs text-muted-foreground">오버라이드</span>
    </div>
  )
}

export type Scope = 'global' | 'project'

export function isProjectOverride(scope: Scope, project: Partial<ClaudeSettings>, key: keyof ClaudeSettings): boolean {
  return scope === 'project' && project[key] !== undefined && project[key] !== null
}

export function isUsingGlobal(scope: Scope, project: Partial<ClaudeSettings>, key: keyof ClaudeSettings): boolean {
  return scope === 'project' && (project[key] === undefined || project[key] === null)
}

export function ResetButton({ onReset, settingKey }: { onReset: (k: string) => void; settingKey: string }) {
  return (
    <button
      onClick={() => onReset(settingKey)}
      className="ml-2 flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <RotateCcw size={11} />
      초기화
    </button>
  )
}

export interface SettingItemProps {
  scope: Scope
  settingKey: keyof ClaudeSettings
  projectValue: unknown
  globalValue: unknown
  onReset: (key: string) => void
  children: React.ReactNode
  label: string
  hint?: string
  sessionRestart?: boolean
}

export function SettingItem({
  scope,
  settingKey,
  projectValue,
  globalValue,
  onReset,
  children,
  label,
  hint,
  sessionRestart,
}: SettingItemProps) {
  const isProjectScope = scope === 'project'
  const hasProjectOverride = projectValue !== undefined && projectValue !== null
  const isUsingGlobal = isProjectScope && !hasProjectOverride

  return (
    <div className="relative flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isProjectScope && hasProjectOverride && (
            <span className="h-4 w-0.5 rounded-full bg-primary" />
          )}
          <label className="text-sm font-medium text-foreground">{label}</label>
          {sessionRestart && (
            <span className="text-xs text-muted-foreground">다음 세션부터 적용됩니다</span>
          )}
        </div>
        {isProjectScope && hasProjectOverride && (
          <button
            onClick={() => onReset(settingKey as string)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RotateCcw size={11} />
            초기화
          </button>
        )}
      </div>
      {isUsingGlobal ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          <span>{globalValue !== undefined && globalValue !== null ? String(globalValue) : '미설정'}</span>
          <span className="ml-2 text-xs text-muted-foreground/70">전역 설정 사용 중</span>
        </div>
      ) : (
        children
      )}
      {hint && !isUsingGlobal && (
        <p className="text-xs text-muted-foreground/70">{hint}</p>
      )}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors',
        checked ? 'bg-primary' : 'bg-muted',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 translate-y-0.5 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </label>
  )
}

export function TagList({
  items,
  onRemove,
  onAdd,
  placeholder,
  disabled,
}: {
  items: string[]
  onRemove: (idx: number) => void
  onAdd: (value: string) => void
  placeholder: string
  disabled?: boolean
}) {
  const [input, setInput] = useState('')

  const commit = (): void => {
    const trimmed = input.trim()
    if (trimmed && !disabled) {
      onAdd(trimmed)
      setInput('')
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {items.map((entry, idx) => (
        <div
          key={idx}
          className="flex items-center justify-between rounded bg-muted px-3 py-1.5"
        >
          <span className="text-sm text-foreground">{entry}</span>
          {!disabled && (
            <button onClick={() => onRemove(idx)} className="ml-2 text-muted-foreground hover:text-foreground">
              <X size={14} />
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <div className="mt-1 flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
            placeholder={placeholder}
            className="flex-1 rounded-md border border-border bg-muted px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-ring focus:outline-none"
          />
          <button
            onClick={commit}
            className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm text-foreground hover:bg-accent/80"
          >
            <Plus size={14} />
            추가
          </button>
        </div>
      )}
    </div>
  )
}

export function EnvEditor({
  env,
  onChange,
  disabled,
}: {
  env: Record<string, string>
  onChange: (env: Record<string, string>) => void
  disabled?: boolean
}) {
  const [newKey, setNewKey] = useState('')
  const [newVal, setNewVal] = useState('')

  const entries = Object.entries(env)

  const remove = (key: string): void => {
    const next = { ...env }
    delete next[key]
    onChange(next)
  }

  const add = (): void => {
    const k = newKey.trim()
    const v = newVal.trim()
    if (k && !disabled) {
      onChange({ ...env, [k]: v })
      setNewKey('')
      setNewVal('')
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-2 rounded bg-muted px-3 py-1.5">
          <span className="w-40 shrink-0 truncate text-sm font-medium text-primary">{k}</span>
          <span className="flex-1 truncate text-sm text-foreground">{v}</span>
          {!disabled && (
            <button onClick={() => remove(k)} className="text-muted-foreground hover:text-foreground">
              <Trash2 size={14} />
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <div className="mt-1 flex gap-2">
          <input
            type="text"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="KEY"
            className="w-36 rounded-md border border-border bg-muted px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-ring focus:outline-none"
          />
          <input
            type="text"
            value={newVal}
            onChange={(e) => setNewVal(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="value"
            className="flex-1 rounded-md border border-border bg-muted px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-ring focus:outline-none"
          />
          <button
            onClick={add}
            className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm text-foreground hover:bg-accent/80"
          >
            <Plus size={14} />
            추가
          </button>
        </div>
      )}
    </div>
  )
}

export const INPUT_CLASS =
  'w-full rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-ring focus:outline-none'

export const SELECT_CLASS =
  'w-full rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none'
