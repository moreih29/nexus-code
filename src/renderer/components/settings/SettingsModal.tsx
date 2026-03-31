import { useState, useEffect } from 'react'
import { X, Cpu, Palette, Shield, Puzzle, Terminal, Settings2 } from 'lucide-react'
import { useSettingsStore, type Theme, type ToolDensity } from '../../stores/settings-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
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

export function SettingsModal({ isOpen, onClose, initialScope = 'global' }: SettingsModalProps) {
  const [activeCategory, setActiveCategory] = useState<Category>('model')

  const store = useSettingsStore()
  const { workspaces, activeWorkspace } = useWorkspaceStore()

  const activeWorkspaceEntry = workspaces.find((w) => w.path === activeWorkspace)

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

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const handleUpdate = (key: keyof ClaudeSettings, value: unknown): void => {
    void updateSetting(scope, key as string, value)
  }

  const handleReset = (key: string): void => {
    void resetProjectSetting(key)
  }

  const panelProps = {
    scope,
    global: globalSettings,
    project: projectSettings,
    effective,
    onUpdate: handleUpdate,
    onReset: handleReset,
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
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
            {scope === 'project' && activeWorkspaceEntry && (
              <span className="text-sm text-muted-foreground">
                워크스페이스: {activeWorkspaceEntry.path.split('/').pop()}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
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
                onThemeChange={(t: Theme) => setTheme(t)}
                onToolDensityChange={(d: ToolDensity) => setToolDensity(d)}
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
      </div>
    </div>
  )
}
