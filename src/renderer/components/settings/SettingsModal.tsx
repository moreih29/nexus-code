import { useState, useEffect, useCallback } from 'react'
import { X, Cpu, Palette, Shield, Puzzle, Terminal, Settings2 } from 'lucide-react'
import { useSettingsStore, type Theme, type ToolDensity } from '../../stores/settings-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useActiveSession } from '../../stores/session-store'
import type { ClaudeSettings } from '../../../shared/types'
import { cn } from '../../lib/utils'
import { PanelModel } from './panel-model'
import { PanelAppearance } from './panel-appearance'
import { PanelPermissions } from './panel-permissions'
import { PanelPlugins } from './panel-plugins'
import { PanelEnvironment } from './panel-environment'
import { PanelAdvanced } from './panel-advanced'
import type { Scope } from './settings-shared'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  initialScope?: 'global' | 'project'
  workspacePath?: string
}

type Category = 'model' | 'appearance' | 'permissions' | 'plugins' | 'environment' | 'advanced'

const CATEGORIES: { id: Category; label: string; icon: React.ElementType; scopes: readonly Scope[] }[] = [
  { id: 'model', label: '모델 및 응답', icon: Cpu, scopes: ['global', 'project'] as const },
  { id: 'appearance', label: '외관', icon: Palette, scopes: ['global'] as const },
  { id: 'permissions', label: '권한', icon: Shield, scopes: ['global', 'project'] as const },
  { id: 'plugins', label: '플러그인', icon: Puzzle, scopes: ['global', 'project'] as const },
  { id: 'environment', label: '환경', icon: Terminal, scopes: ['global', 'project'] as const },
  { id: 'advanced', label: '고급', icon: Settings2, scopes: ['global', 'project'] as const },
]

// restart가 필요한 설정 키 목록
const RESTART_KEYS = new Set(['model', 'effortLevel', 'permissions', 'permissionMode', 'env', 'sandbox'])

export function SettingsModal({ isOpen, onClose, initialScope = 'global', workspacePath }: SettingsModalProps) {
  const [activeCategory, setActiveCategory] = useState<Category>('model')
  const [pendingChanges, setPendingChanges] = useState<Record<string, unknown>>({})

  const store = useSettingsStore()
  const { workspaces, activeWorkspace } = useWorkspaceStore()
  const sessionStatus = useActiveSession((s) => s.status)
  const restartSession = useActiveSession((s) => s.restartSession)
  const sessionId = useActiveSession((s) => s.sessionId)

  // 대상 워크스페이스: 명시적 경로 > 활성 워크스페이스
  const targetWorkspacePath = workspacePath ?? activeWorkspace
  const targetWorkspaceEntry = workspaces.find((w) => w.path === targetWorkspacePath)

  // 워크스페이스 설정 모달이 열릴 때 해당 워크스페이스의 settings를 로드 + 스냅샷 저장
  useEffect(() => {
    if (!isOpen) return

    // 스냅샷 저장 + pending 초기화
    useSettingsStore.getState().takeSnapshot()
    setPendingChanges({})

    if (initialScope !== 'project' || !targetWorkspacePath) return
    useSettingsStore.getState().initialize(targetWorkspacePath).catch(() => {})
    return () => {
      // 모달 닫힐 때 활성 워크스페이스의 settings로 복원
      if (activeWorkspace && activeWorkspace !== targetWorkspacePath) {
        useSettingsStore.getState().initialize(activeWorkspace).catch(() => {})
      }
    }
  }, [isOpen, initialScope, targetWorkspacePath, activeWorkspace])

  const {
    global: globalSettings,
    project: projectSettings,
    effective,
    theme,
    toolDensity,
    notificationsEnabled,
    setTheme,
    setToolDensity,
    setNotificationsEnabled,
    updateSetting,
    resetProjectSetting,
  } = store

  const scope: Scope = initialScope

  const visibleCategories = CATEGORIES.filter((c) => c.scopes.includes(scope))

  useEffect(() => {
    if (!isOpen) return
    const firstVisible = visibleCategories[0]
    if (firstVisible && !visibleCategories.find((c) => c.id === activeCategory)) {
      setActiveCategory(firstVisible.id)
    }
  }, [isOpen, scope])

  const handleCancel = useCallback(() => {
    // 스냅샷 원복 (시각 설정 복원) + pending 버림
    useSettingsStore.getState().restoreSnapshot()
    useSettingsStore.getState().clearSnapshot()
    setPendingChanges({})
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancel()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, handleCancel])

  if (!isOpen) return null

  const handleUpdate = (key: keyof ClaudeSettings, value: unknown): void => {
    setPendingChanges((prev) => ({ ...prev, [key as string]: value }))
    // 시각 설정은 즉시 미리보기 (파일 저장 안 함)
    if (key === 'theme') setTheme(value as Theme)
    if (key === 'toolDensity') setToolDensity(value as ToolDensity)
  }

  const handleReset = (key: string): void => {
    setPendingChanges((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    // project scope에서 reset은 pending에서 제거하고 실제 삭제는 저장 시 처리
  }

  // pending 변경사항 적용 시 사용하는 effective (미리보기용)
  const pendingGlobal = scope === 'global'
    ? { ...globalSettings, ...pendingChanges }
    : globalSettings
  const pendingProject = scope === 'project'
    ? { ...projectSettings, ...pendingChanges }
    : projectSettings

  // pending에서 삭제된 키 반영 (reset된 항목)
  const panelProps = {
    scope,
    global: pendingGlobal,
    project: pendingProject,
    effective: { ...effective, ...pendingChanges },
    onUpdate: handleUpdate,
    onReset: handleReset,
  }

  const hasPendingChanges = Object.keys(pendingChanges).length > 0

  // 시각 설정 키 — ClaudeSettings와 무관, settings.json에 저장 불필요
  const VISUAL_KEYS = new Set(['theme', 'toolDensity'])

  const handleSave = async (): Promise<void> => {
    // 시각 설정 키 제외하고 파일에 저장
    for (const [key, value] of Object.entries(pendingChanges)) {
      if (VISUAL_KEYS.has(key)) continue
      await updateSetting(scope, key, value, targetWorkspacePath ?? undefined)
    }

    // 시각 설정은 store에 확정 (이미 미리보기로 반영됨)
    if ('theme' in pendingChanges) setTheme(pendingChanges['theme'] as Theme)
    if ('toolDensity' in pendingChanges) setToolDensity(pendingChanges['toolDensity'] as ToolDensity)

    // restart 필요 설정이 변경된 경우 1회 restart+resume
    const needsRestart =
      sessionId &&
      sessionStatus !== 'restarting' &&
      Object.keys(pendingChanges).some((k) => RESTART_KEYS.has(k))

    if (needsRestart && targetWorkspacePath) {
      const pendingModel = pendingChanges['model'] as string | undefined
      const pendingEffort = pendingChanges['effortLevel'] as string | undefined
      const pendingPermMode = pendingChanges['permissionMode'] as string | undefined
      await restartSession({
        cwd: targetWorkspacePath,
        model: pendingModel,
        effortLevel: pendingEffort,
        permissionMode: pendingPermMode,
      })
    }

    useSettingsStore.getState().clearSnapshot()
    setPendingChanges({})
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleCancel}
    >
      <div
        className="flex w-[680px] h-[70vh] flex-col rounded-xl bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-lg font-semibold text-foreground">
              {scope === 'project' ? '워크스페이스 설정' : '전역 설정'}
            </h2>
            {scope === 'project' && targetWorkspaceEntry && (
              <span className="text-sm text-muted-foreground">
                워크스페이스: {targetWorkspaceEntry.path.split('/').pop()}
              </span>
            )}
          </div>
          <button
            onClick={handleCancel}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X size={18} />
          </button>
        </div>

        {/* 본문: 좌측 네비 + 우측 콘텐츠 */}
        <div className="flex min-h-0 flex-1">
          {/* 좌측 카테고리 네비 */}
          <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-border px-2 py-3">
            {visibleCategories.map((cat) => {
              const Icon = cat.icon
              return (
                <button
                  key={cat.id}
                  onClick={() => setActiveCategory(cat.id)}
                  className={cn(
                    'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors text-left',
                    activeCategory === cat.id
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon size={16} />
                  {cat.label}
                </button>
              )
            })}
          </nav>

          {/* 우측 설정 콘텐츠 */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {activeCategory === 'model' && (
              <PanelModel {...panelProps} />
            )}
            {activeCategory === 'appearance' && (
              <PanelAppearance
                {...panelProps}
                theme={theme}
                toolDensity={toolDensity}
                notificationsEnabled={notificationsEnabled}
                onThemeChange={(t: Theme) => handleUpdate('theme' as keyof ClaudeSettings, t)}
                onToolDensityChange={(d: ToolDensity) => handleUpdate('toolDensity' as keyof ClaudeSettings, d)}
                onNotificationsChange={setNotificationsEnabled}
              />
            )}
            {activeCategory === 'permissions' && (
              <PanelPermissions {...panelProps} />
            )}
            {activeCategory === 'plugins' && (
              <PanelPlugins {...panelProps} />
            )}
            {activeCategory === 'environment' && (
              <PanelEnvironment {...panelProps} />
            )}
            {activeCategory === 'advanced' && (
              <PanelAdvanced {...panelProps} />
            )}
          </div>
        </div>

        {/* 하단 버튼 */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-6 py-3">
          <button
            onClick={handleCancel}
            className="rounded-md px-4 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            취소
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={!hasPendingChanges}
            className={cn(
              'rounded-md px-4 py-2 text-sm font-medium transition-colors',
              hasPendingChanges
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-muted text-muted-foreground cursor-not-allowed opacity-50',
            )}
          >
            저장
          </button>
        </div>
      </div>
    </div>
  )
}
