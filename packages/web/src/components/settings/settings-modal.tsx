import { useEffect, useState } from 'react'
import { X, RotateCcw, Info } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { useSettingsStore, MODELS, type AppSettings, type CliSettings, type SettingsScope } from '@/stores/settings-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useWorkspaces } from '@/hooks/use-workspaces'

import { useTheme, THEMES } from '@/hooks/use-theme'
import { cn } from '@/lib/utils'

type Tab = 'app' | 'nexus' | 'claude-code'

const BUILTIN_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Agent',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
] as const

type BuiltinTool = (typeof BUILTIN_TOOLS)[number]

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
      {children}
    </h3>
  )
}

function FieldRow({
  label,
  children,
  onReset,
  hasOverride,
}: {
  label: string
  children: React.ReactNode
  onReset?: () => void
  hasOverride?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="flex items-center min-w-0">
        <span className="text-xs text-[var(--text-secondary)] whitespace-nowrap">{label}</span>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {children}
        {onReset && hasOverride && (
          <button
            onClick={onReset}
            title="전역 설정 사용"
            className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--yellow)] transition-colors"
          >
            <RotateCcw className="size-3" />
          </button>
        )}
      </div>
    </div>
  )
}

function TagInput({
  values,
  onChange,
  placeholder,
  inputId,
}: {
  values: string[]
  onChange: (values: string[]) => void
  placeholder?: string
  inputId: string
}) {
  const [inputValue, setInputValue] = useState('')

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if ((e.key === 'Enter' || e.key === ',') && inputValue.trim()) {
      e.preventDefault()
      const newVal = inputValue.trim().replace(/,$/, '')
      if (newVal && !values.includes(newVal)) {
        onChange([...values, newVal])
      }
      setInputValue('')
    } else if (e.key === 'Backspace' && !inputValue && values.length > 0) {
      onChange(values.slice(0, -1))
    }
  }

  function removeTag(idx: number) {
    onChange(values.filter((_, i) => i !== idx))
  }

  return (
    <div
      className="flex flex-wrap gap-1 min-h-7 w-full p-1 rounded border border-[var(--border)] bg-[var(--bg-base)] focus-within:border-[var(--accent)] cursor-text"
      onClick={() => {
        const input = document.getElementById(inputId) as HTMLInputElement | null
        input?.focus()
      }}
    >
      {values.map((v, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-secondary)] text-[10px]"
        >
          {v}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); removeTag(i) }}
            className="hover:text-[var(--red)]"
          >
            <X className="size-2.5" />
          </button>
        </span>
      ))}
      <input
        id={inputId}
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={values.length === 0 ? placeholder : ''}
        className="flex-1 min-w-12 bg-transparent text-[10px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
      />
    </div>
  )
}

function DisallowedToolsInput({
  values,
  onChange,
}: {
  values: string[]
  onChange: (values: string[]) => void
}) {
  const builtinBlocked = new Set(values.filter((v) => (BUILTIN_TOOLS as readonly string[]).includes(v)))
  const customValues = values.filter((v) => !(BUILTIN_TOOLS as readonly string[]).includes(v))

  function toggleBuiltin(tool: BuiltinTool) {
    const next = new Set(builtinBlocked)
    if (next.has(tool)) {
      next.delete(tool)
    } else {
      next.add(tool)
    }
    onChange([...next, ...customValues])
  }

  function handleCustomChange(vals: string[]) {
    onChange([...builtinBlocked, ...vals])
  }

  return (
    <div className="w-full rounded border border-[var(--border)] bg-[var(--bg-base)] p-2 space-y-2">
      <div className="grid grid-cols-3 gap-x-3 gap-y-1">
        {BUILTIN_TOOLS.map((tool) => (
          <label
            key={tool}
            className="flex items-center gap-1.5 cursor-pointer group"
          >
            <input
              type="checkbox"
              checked={builtinBlocked.has(tool)}
              onChange={() => toggleBuiltin(tool)}
              className="w-3 h-3 rounded border border-[var(--border)] accent-[var(--accent)] cursor-pointer"
            />
            <span className={cn(
              'text-[10px] transition-colors',
              builtinBlocked.has(tool)
                ? 'text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] group-hover:text-[var(--text-secondary)]'
            )}>
              {tool}
            </span>
          </label>
        ))}
      </div>
      <div className="border-t border-[var(--border)] pt-2">
        <span className="text-[10px] text-[var(--text-muted)] block mb-1">커스텀</span>
        <TagInput
          inputId="tag-disallowed-tools-custom"
          values={customValues}
          onChange={handleCustomChange}
          placeholder="MCP 도구 등..."
        />
        <p className="text-[10px] text-[var(--text-muted)] mt-1">
          Enter 또는 쉼표로 추가
        </p>
      </div>
    </div>
  )
}

function inputClass(isInherited?: boolean) {
  return cn(
    'w-36 rounded border border-[var(--border)] bg-[var(--bg-base)] px-2 py-1 text-xs focus:outline-none focus:border-[var(--accent)] transition-colors',
    isInherited
      ? 'text-[var(--text-muted)] placeholder:text-[var(--text-muted)]'
      : 'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]'
  )
}

function selectClass() {
  return 'w-36 rounded border border-[var(--border)] bg-[var(--bg-base)] px-2 py-1 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors'
}

export function SettingsModal() {
  const {
    modalOpen,
    setModalOpen,
    scope,
    setScope,
    globalSettings,
    projectSettings,
    globalCliSettings,
    projectCliSettings,
    draftGlobal,
    draftProject,
    draftGlobalCli,
    draftProjectCli,
    isLoading,
    loadSettings,
    updateDraft,
    updateDraftCli,
    resetProjectKey,
    quickSave,
  } = useSettingsStore()

  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const { data: workspaces } = useWorkspaces()

  const { theme, setTheme } = useTheme()

  const [activeTab, setActiveTab] = useState<Tab>('app')
  const [permissionsText, setPermissionsText] = useState('')
  const [permissionsError, setPermissionsError] = useState('')

  // Find active workspace path
  const activeWorkspace = workspaces?.find((w) => w.id === activeWorkspaceId)
  const workspacePath = activeWorkspace?.path ?? null
  const workspaceName = activeWorkspace
    ? (activeWorkspace.path.split('/').pop() ?? activeWorkspace.path)
    : null

  // Load settings when modal opens; default to project scope if workspace is active
  useEffect(() => {
    if (modalOpen) {
      if (workspacePath) {
        setScope('project')
      } else {
        setScope('global')
      }
      void loadSettings(workspacePath)
    }
  }, [modalOpen, workspacePath]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync permissions textarea when cli settings change
  useEffect(() => {
    const cliSettings = scope === 'global' ? draftGlobalCli : draftProjectCli
    const perms = cliSettings.permissions
    if (perms) {
      setPermissionsText(JSON.stringify(perms, null, 2))
    } else {
      setPermissionsText('')
    }
    setPermissionsError('')
  }, [scope, draftGlobalCli, draftProjectCli])

  // Current draft
  const draft = scope === 'global' ? draftGlobal : draftProject
  const draftCli = scope === 'global' ? draftGlobalCli : draftProjectCli

  // Global values for placeholder display in project scope
  const globalDraft = draftGlobal
  const globalCliDraft = draftGlobalCli

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

  /** Auto-save a setting change to server immediately */
  function autoSave(partial: Partial<AppSettings>) {
    updateDraft(scope, partial)
    void quickSave(partial, scope === 'project' ? workspacePath : null)
  }

  function handlePermissionsBlur() {
    const text = permissionsText.trim()
    if (!text) {
      updateDraftCli(scope, { ...draftCli, permissions: undefined })
      setPermissionsError('')
      return
    }
    try {
      const parsed = JSON.parse(text) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        updateDraftCli(scope, { ...draftCli, permissions: parsed as CliSettings['permissions'] })
        setPermissionsError('')
      } else {
        setPermissionsError('객체 형식이어야 합니다. 예: {"allow": [], "deny": []}')
      }
    } catch {
      setPermissionsError('유효한 JSON이 아닙니다')
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'app', label: '앱' },
    { id: 'nexus', label: '넥서스' },
    { id: 'claude-code', label: 'Claude Code' },
  ]

  const showScopeToggle = activeTab === 'nexus' || activeTab === 'claude-code'

  return (
    <>
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="flex flex-col max-w-2xl h-[70vh] max-h-[600px] p-0 gap-0 overflow-hidden">
          {/* Header */}
          <DialogHeader className="px-5 pt-4 pb-3 border-b border-[var(--border)] flex-shrink-0">
            <DialogTitle className="text-sm font-semibold text-[var(--text-primary)]">설정</DialogTitle>
          </DialogHeader>

          {/* Body: sidebar + content */}
          <div className="flex flex-1 min-h-0">
            {/* Left tab sidebar */}
            <div className="w-32 flex-shrink-0 bg-[var(--bg-base)] border-r border-[var(--border)] flex flex-col pt-2">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'py-2 px-3 text-xs text-left transition-colors',
                    activeTab === tab.id
                      ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] border-l-2 border-[var(--accent)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] border-l-2 border-transparent'
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Right content */}
            <div className="flex flex-col flex-1 min-w-0">
              {/* Scope segment control — only for nexus and claude-code tabs */}
              {showScopeToggle && (
                <div className="px-5 pt-3 pb-3 border-b border-[var(--border)] flex-shrink-0">
                  <div className="flex rounded-md bg-[var(--bg-base)] p-0.5 gap-0.5">
                    <button
                      onClick={() => setScope('global')}
                      className={cn(
                        'flex-1 rounded px-2 py-1 text-xs font-medium transition-colors',
                        scope === 'global'
                          ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-sm'
                          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                      )}
                    >
                      전역
                    </button>
                    <button
                      onClick={() => workspacePath && setScope('project')}
                      disabled={!workspacePath}
                      className={cn(
                        'flex-1 rounded px-2 py-1 text-xs font-medium transition-colors truncate',
                        scope === 'project'
                          ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-sm'
                          : workspacePath
                            ? 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                            : 'text-[var(--text-muted)] opacity-40 cursor-not-allowed'
                      )}
                      title={workspaceName ? `프로젝트: ${workspaceName}` : '워크스페이스를 먼저 선택하세요'}
                    >
                      {workspaceName ? `프로젝트: ${workspaceName}` : '프로젝트'}
                    </button>
                  </div>
                </div>
              )}

              {/* Scroll area */}
              <ScrollArea className="flex-1 min-h-0">
                {isLoading ? (
                  <div className="flex items-center justify-center h-32 text-xs text-[var(--text-muted)]">
                    불러오는 중...
                  </div>
                ) : (
                  <div className="px-5 py-4">

                    {/* App tab */}
                    {activeTab === 'app' && (
                      <section>
                        <SectionHeader>테마</SectionHeader>
                        <div className="grid grid-cols-4 gap-2">
                          {THEMES.map((t) => (
                            <button
                              key={t.id}
                              onClick={() => { setTheme(t.id); void quickSave({ theme: t.id }, null) }}
                              className={cn(
                                'rounded-md border transition-colors text-left overflow-hidden',
                                theme === t.id
                                  ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]'
                                  : 'border-[var(--border)] hover:border-[var(--text-muted)]'
                              )}
                            >
                              {/* Swatch: accent strip (top) + bg strip (bottom) */}
                              <div className="relative">
                                <div
                                  className="h-5 w-full"
                                  style={{ backgroundColor: t.palette[2] }}
                                >
                                  {/* Semantic color dot on accent strip */}
                                  <span
                                    className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full border border-black/20"
                                    style={{ backgroundColor: t.palette[3] }}
                                  />
                                </div>
                                <div className="h-3 w-full flex">
                                  <div className="flex-1" style={{ backgroundColor: t.palette[0] }} />
                                  <div className="flex-1" style={{ backgroundColor: t.palette[1] }} />
                                </div>
                              </div>
                              <span className="block px-2 py-1.5 text-[10px] text-[var(--text-muted)]">
                                {t.label}
                              </span>
                            </button>
                          ))}
                        </div>
                        <p className="text-[10px] text-[var(--text-muted)] mt-3">
                          테마 변경은 즉시 적용됩니다
                        </p>
                      </section>
                    )}

                    {/* Nexus tab */}
                    {activeTab === 'nexus' && (
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
                    )}

                    {/* Claude Code tab */}
                    {activeTab === 'claude-code' && (
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
                              const { alwaysThinkingEnabled: _, ...rest } = draftProjectCli
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
                              onChange={(e) => setPermissionsText(e.target.value)}
                              onBlur={handlePermissionsBlur}
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
                              const { language: _, ...rest } = draftProjectCli
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
                    )}

                  </div>
                )}
              </ScrollArea>

              {/* Footer: auto-save indicator */}
              <div className="px-5 py-2 border-t border-[var(--border)] flex-shrink-0">
                <p className="text-[10px] text-[var(--text-muted)] text-center">
                  변경사항은 자동으로 저장됩니다
                </p>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
