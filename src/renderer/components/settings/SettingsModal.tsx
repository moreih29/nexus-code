import { useEffect, useState } from 'react'
import { X, Plus, Trash2 } from 'lucide-react'
import { IpcChannel } from '../../../shared/ipc'
import type {
  ClaudeSettings,
  ReadSettingsResponse,
  WriteSettingsResponse,
} from '../../../shared/types'
import { useSettingsStore, AVAILABLE_MODELS, type ModelId } from '../../stores/settings-store'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

type Tab = 'general' | 'permissions' | 'advanced'

const PERMISSION_MODES = [
  { value: 'bypassPermissions', label: '자동 (위험 가능)' },
  { value: 'acceptEdits', label: '편집 자동 허용' },
  { value: 'default', label: '기본' },
  { value: 'dontAsk', label: '묻지 않기' },
  { value: 'plan', label: '계획 모드' },
]

const EFFORT_LEVELS = ['low', 'medium', 'high', 'max']
const TEAMMATE_MODES = ['auto', 'enabled', 'disabled']

function TagList({
  items,
  onRemove,
  onAdd,
  placeholder,
}: {
  items: string[]
  onRemove: (idx: number) => void
  onAdd: (value: string) => void
  placeholder: string
}) {
  const [input, setInput] = useState('')

  const commit = (): void => {
    const trimmed = input.trim()
    if (trimmed) {
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
          <button onClick={() => onRemove(idx)} className="ml-2 text-muted-foreground hover:text-foreground">
            <X size={14} />
          </button>
        </div>
      ))}
      <div className="mt-1 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          placeholder={placeholder}
          className="flex-1 rounded-md border border-border bg-muted px-3 py-1.5 text-sm text-foreground placeholder-dim-foreground focus:border-ring focus:outline-none"
        />
        <button
          onClick={commit}
          className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm text-foreground hover:bg-accent"
        >
          <Plus size={14} />
          추가
        </button>
      </div>
    </div>
  )
}

function EnvEditor({
  env,
  onChange,
}: {
  env: Record<string, string>
  onChange: (env: Record<string, string>) => void
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
    if (k) {
      onChange({ ...env, [k]: v })
      setNewKey('')
      setNewVal('')
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-2 rounded bg-muted px-3 py-1.5">
          <span className="w-40 shrink-0 truncate text-sm font-medium text-blue-300">{k}</span>
          <span className="flex-1 truncate text-sm text-foreground">{v}</span>
          <button onClick={() => remove(k)} className="text-muted-foreground hover:text-foreground">
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="mt-1 flex gap-2">
        <input
          type="text"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="KEY"
          className="w-36 rounded-md border border-border bg-muted px-3 py-1.5 text-sm text-foreground placeholder-dim-foreground focus:border-ring focus:outline-none"
        />
        <input
          type="text"
          value={newVal}
          onChange={(e) => setNewVal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="value"
          className="flex-1 rounded-md border border-border bg-muted px-3 py-1.5 text-sm text-foreground placeholder-dim-foreground focus:border-ring focus:outline-none"
        />
        <button
          onClick={add}
          className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm text-foreground hover:bg-accent"
        >
          <Plus size={14} />
          추가
        </button>
      </div>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ${
        checked ? 'bg-blue-600' : 'bg-muted'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 translate-y-0.5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <label className="mb-2 block text-sm font-medium text-muted-foreground">{children}</label>
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { model, setModel } = useSettingsStore()
  const [activeTab, setActiveTab] = useState<Tab>('general')

  const [globalSettings, setGlobalSettings] = useState<ClaudeSettings>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // General
  const [language, setLanguage] = useState('')
  const [effortLevel, setEffortLevel] = useState('high')
  const [autoMemoryEnabled, setAutoMemoryEnabled] = useState(false)
  const [skipDangerousPrompt, setSkipDangerousPrompt] = useState(false)
  const [teammateMode, setTeammateMode] = useState('auto')

  // Permissions
  const [permissionMode, setPermissionMode] = useState('default')
  const [allowList, setAllowList] = useState<string[]>([])
  const [denyList, setDenyList] = useState<string[]>([])

  // Plugins
  const [enabledPlugins, setEnabledPlugins] = useState<Record<string, boolean>>({})

  // Advanced
  const [env, setEnv] = useState<Record<string, string>>({})
  const [statusLineJson, setStatusLineJson] = useState('')
  const [marketplacesJson, setMarketplacesJson] = useState('')

  useEffect(() => {
    if (!isOpen) return
    setLoading(true)
    window.electronAPI
      .invoke<ReadSettingsResponse>(IpcChannel.SETTINGS_READ)
      .then((res) => {
        const s = res.global
        setGlobalSettings(s)

        setLanguage(s.language ?? '')
        setEffortLevel(s.effortLevel ?? 'high')
        setAutoMemoryEnabled(s.autoMemoryEnabled ?? false)
        setSkipDangerousPrompt(s.skipDangerousModePermissionPrompt ?? false)
        setTeammateMode(s.teammateMode ?? 'auto')

        setPermissionMode(s.permissions?.defaultMode ?? 'default')
        setAllowList(s.permissions?.allow ?? [])
        setDenyList(s.permissions?.deny ?? [])

        setEnabledPlugins(s.enabledPlugins ?? {})

        setEnv(s.env ?? {})
        setStatusLineJson(s.statusLine ? JSON.stringify(s.statusLine, null, 2) : '')
        setMarketplacesJson(
          s.extraKnownMarketplaces ? JSON.stringify(s.extraKnownMarketplaces, null, 2) : '',
        )
      })
      .catch(() => {
        // file missing or parse error — use defaults
      })
      .finally(() => setLoading(false))
  }, [isOpen])

  if (!isOpen) return null

  const handleSave = async (): Promise<void> => {
    setSaving(true)

    let parsedStatusLine: unknown = undefined
    let parsedMarketplaces: unknown = undefined
    try {
      if (statusLineJson.trim()) parsedStatusLine = JSON.parse(statusLineJson)
    } catch {
      // keep existing
      parsedStatusLine = globalSettings.statusLine
    }
    try {
      if (marketplacesJson.trim()) parsedMarketplaces = JSON.parse(marketplacesJson)
    } catch {
      parsedMarketplaces = globalSettings.extraKnownMarketplaces
    }

    const updated: ClaudeSettings = {
      ...globalSettings,
      permissions: {
        ...globalSettings.permissions,
        defaultMode: permissionMode,
        allow: allowList,
        deny: denyList,
      },
      enabledPlugins,
      env,
      language: language || undefined,
      effortLevel,
      autoMemoryEnabled,
      skipDangerousModePermissionPrompt: skipDangerousPrompt,
      teammateMode,
      statusLine: parsedStatusLine,
      extraKnownMarketplaces: parsedMarketplaces,
    }

    await window.electronAPI.invoke<WriteSettingsResponse>(IpcChannel.SETTINGS_WRITE, {
      scope: 'global',
      settings: updated,
    })
    setSaving(false)
    onClose()
  }

  const knownPlugins = Object.keys(enabledPlugins)

  const tabs: { id: Tab; label: string }[] = [
    { id: 'general', label: '일반' },
    { id: 'permissions', label: '퍼미션' },
    { id: 'advanced', label: '고급' },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex w-[560px] max-h-[85vh] flex-col rounded-xl bg-card shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-lg font-semibold text-foreground">Settings</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 gap-1 border-b border-border px-6 pt-3">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`rounded-t px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'border-b-2 border-blue-500 text-blue-400'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Loading...</div>
          ) : (
            <>
              {/* ── 일반 탭 ── */}
              {activeTab === 'general' && (
                <div className="flex flex-col gap-5">
                  <section>
                    <SectionLabel>모델</SectionLabel>
                    <select
                      value={model}
                      onChange={(e) => setModel(e.target.value as ModelId)}
                      className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none"
                    >
                      {AVAILABLE_MODELS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </section>

                  <section>
                    <SectionLabel>언어 (language)</SectionLabel>
                    <input
                      type="text"
                      value={language}
                      onChange={(e) => setLanguage(e.target.value)}
                      placeholder="한글, English, ..."
                      className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-dim-foreground focus:border-ring focus:outline-none"
                    />
                  </section>

                  <section>
                    <SectionLabel>처리 강도 (effortLevel)</SectionLabel>
                    <div className="flex gap-2">
                      {EFFORT_LEVELS.map((level) => (
                        <label
                          key={level}
                          className="flex cursor-pointer items-center gap-1.5 text-sm text-foreground"
                        >
                          <input
                            type="radio"
                            name="effortLevel"
                            value={level}
                            checked={effortLevel === level}
                            onChange={(e) => setEffortLevel(e.target.value)}
                            className="accent-blue-500"
                          />
                          {level}
                        </label>
                      ))}
                    </div>
                  </section>

                  <section>
                    <SectionLabel>팀원 모드 (teammateMode)</SectionLabel>
                    <div className="flex gap-4">
                      {TEAMMATE_MODES.map((mode) => (
                        <label
                          key={mode}
                          className="flex cursor-pointer items-center gap-1.5 text-sm text-foreground"
                        >
                          <input
                            type="radio"
                            name="teammateMode"
                            value={mode}
                            checked={teammateMode === mode}
                            onChange={(e) => setTeammateMode(e.target.value)}
                            className="accent-blue-500"
                          />
                          {mode}
                        </label>
                      ))}
                    </div>
                  </section>

                  <section className="flex flex-col gap-3">
                    <SectionLabel>옵션</SectionLabel>
                    <label className="flex cursor-pointer items-center justify-between">
                      <span className="text-sm text-foreground">자동 메모리 (autoMemoryEnabled)</span>
                      <Toggle checked={autoMemoryEnabled} onChange={setAutoMemoryEnabled} />
                    </label>
                    <label className="flex cursor-pointer items-center justify-between">
                      <span className="text-sm text-foreground">
                        위험 모드 퍼미션 프롬프트 생략 (skipDangerousModePermissionPrompt)
                      </span>
                      <Toggle checked={skipDangerousPrompt} onChange={setSkipDangerousPrompt} />
                    </label>
                  </section>
                </div>
              )}

              {/* ── 퍼미션 탭 ── */}
              {activeTab === 'permissions' && (
                <div className="flex flex-col gap-5">
                  <section>
                    <SectionLabel>퍼미션 모드</SectionLabel>
                    <select
                      value={permissionMode}
                      onChange={(e) => setPermissionMode(e.target.value)}
                      className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none"
                    >
                      {PERMISSION_MODES.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </section>

                  <section>
                    <SectionLabel>허용 도구</SectionLabel>
                    <TagList
                      items={allowList}
                      onRemove={(idx) => setAllowList((prev) => prev.filter((_, i) => i !== idx))}
                      onAdd={(v) => setAllowList((prev) => [...prev, v])}
                      placeholder="Bash(bun run:*)"
                    />
                  </section>

                  <section>
                    <SectionLabel>차단 도구</SectionLabel>
                    <TagList
                      items={denyList}
                      onRemove={(idx) => setDenyList((prev) => prev.filter((_, i) => i !== idx))}
                      onAdd={(v) => setDenyList((prev) => [...prev, v])}
                      placeholder="Read(**/.venv/**)"
                    />
                  </section>

                  {knownPlugins.length > 0 && (
                    <section>
                      <SectionLabel>플러그인</SectionLabel>
                      <div className="flex flex-col gap-1">
                        {knownPlugins.map((id) => (
                          <label
                            key={id}
                            className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
                          >
                            <input
                              type="checkbox"
                              checked={!!enabledPlugins[id]}
                              onChange={() =>
                                setEnabledPlugins((prev) => ({ ...prev, [id]: !prev[id] }))
                              }
                              className="accent-blue-500"
                            />
                            {id}
                          </label>
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              )}

              {/* ── 고급 탭 ── */}
              {activeTab === 'advanced' && (
                <div className="flex flex-col gap-5">
                  <section>
                    <SectionLabel>환경 변수 (env)</SectionLabel>
                    <EnvEditor env={env} onChange={setEnv} />
                  </section>

                  <section>
                    <SectionLabel>상태표시줄 (statusLine) — JSON</SectionLabel>
                    <textarea
                      value={statusLineJson}
                      onChange={(e) => setStatusLineJson(e.target.value)}
                      rows={4}
                      spellCheck={false}
                      className="w-full rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground placeholder-dim-foreground focus:border-ring focus:outline-none"
                      placeholder={'{\n  "type": "command",\n  "command": "..."\n}'}
                    />
                  </section>

                  <section>
                    <SectionLabel>추가 마켓플레이스 (extraKnownMarketplaces) — JSON</SectionLabel>
                    <textarea
                      value={marketplacesJson}
                      onChange={(e) => setMarketplacesJson(e.target.value)}
                      rows={6}
                      spellCheck={false}
                      className="w-full rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground placeholder-dim-foreground focus:border-ring focus:outline-none"
                      placeholder={'{\n  "mymarket": { "source": { ... } }\n}'}
                    />
                  </section>
                </div>
              )}
            </>
          )}
        </div>

        {/* Actions */}
        <div className="flex shrink-0 justify-end gap-3 border-t border-border px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            취소
          </button>
          <button
            onClick={handleSave}
            disabled={loading || saving}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  )
}
