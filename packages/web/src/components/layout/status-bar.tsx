import { useEffect } from 'react'
import { Settings, ChevronDown, GitBranch, ShieldCheck, FileCheck2, Telescope, ShieldOff, type LucideIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SettingsModal } from '@/components/settings/settings-modal'
import { MODELS, useSettingsStore, useEffectiveModel, useEffectivePermissionMode, type ModelId, type PermissionMode } from '@/stores/settings-store'
import { useChatStore } from '@/stores/chat-store'
import { useActiveWorkspace } from '@/hooks/use-active-workspace'
import { useTheme } from '@/hooks/use-theme'

const PERMISSION_MODES: { id: PermissionMode; label: string; icon: LucideIcon; description: string }[] = [
  {
    id: 'default',
    label: '기본',
    icon: ShieldCheck,
    description: '위험 작업은 매번 확인',
  },
  {
    id: 'acceptEdits',
    label: '편집 허용',
    icon: FileCheck2,
    description: '편집은 자동, 실행은 확인',
  },
  {
    id: 'plan',
    label: '계획',
    icon: Telescope,
    description: '읽기·탐색만, 편집 차단',
  },
  {
    id: 'bypassPermissions',
    label: '전체 허용',
    icon: ShieldOff,
    description: '모든 확인 건너뜀 (주의)',
  },
]

export function StatusBar() {
  const { modalOpen, setModalOpen, quickSave, loadSettings } = useSettingsStore()
  const defaultModel = useEffectiveModel()
  const defaultPermissionMode = useEffectivePermissionMode()

  const { workspacePath } = useActiveWorkspace()

  // useTheme subscribes to globalSettings.theme and applies it to the DOM automatically
  useTheme()

  // Load settings from server on mount and when workspace changes
  useEffect(() => {
    void loadSettings(workspacePath)
  }, [workspacePath]) // eslint-disable-line react-hooks/exhaustive-deps

  const isConnected = useChatStore((s) => s.isConnected)
  const isWaitingResponse = useChatStore((s) => s.isWaitingResponse)
  const isStreaming = useChatStore((s) => s.sessionState.isStreaming)

  const statusText = isWaitingResponse
    ? '응답 대기 중...'
    : isStreaming
      ? '스트리밍 중...'
      : '준비'

  const currentModelLabel =
    MODELS.find((m) => m.id === defaultModel)?.label ?? defaultModel
  const currentMode = PERMISSION_MODES.find((m) => m.id === defaultPermissionMode) ?? PERMISSION_MODES[0]
  const CurrentPermIcon = currentMode.icon

  function handleModelChange(modelId: ModelId) {
    void quickSave({ model: modelId }, workspacePath)
  }

  function handlePermissionChange(mode: PermissionMode) {
    void quickSave({ permissionMode: mode }, workspacePath)
  }

  return (
    <>
      <div className="flex items-center justify-between px-3 h-7 bg-bg-surface border-t border-border text-xs text-text-muted select-none">
        {/* Left side */}
        <div className="flex items-center gap-2">
          <span className="text-text-secondary">Nexus Code</span>
          <span className="mx-1 text-border">|</span>
          <div className="flex items-center gap-1.5">
            <span
              className="block w-1 h-1 rounded-full flex-shrink-0"
              style={{ background: isConnected ? 'var(--green)' : 'var(--red)' }}
            />
            <span>{statusText}</span>
          </div>
        </div>

        {/* Right side */}
        <div className="flex items-center gap-1">
          {/* Model dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-0.5 px-2 py-0.5 rounded hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                <span>{currentModelLabel}</span>
                <ChevronDown className="size-3 ml-0.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top">
              <DropdownMenuLabel>모델</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {MODELS.map((m) => (
                <DropdownMenuItem
                  key={m.id}
                  onClick={() => handleModelChange(m.id as ModelId)}
                  className={defaultModel === m.id ? 'text-[var(--accent)]' : ''}
                >
                  {m.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Permission mode dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-0.5 px-2 py-0.5 rounded hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                <CurrentPermIcon className="w-3 h-3" />
                <span className="ml-0.5">{currentMode.label}</span>
                <ChevronDown className="size-3 ml-0.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top">
              <DropdownMenuLabel>권한 모드</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {PERMISSION_MODES.map((m) => {
                const Icon = m.icon
                return (
                  <DropdownMenuItem
                    key={m.id}
                    onClick={() => handlePermissionChange(m.id)}
                    className={defaultPermissionMode === m.id ? 'text-[var(--accent)]' : ''}
                  >
                    <Icon className="w-3 h-3 shrink-0" />
                    <span>{m.label}</span>
                    <span className="text-[10px] text-[var(--text-muted)] ml-1">{m.description}</span>
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Settings icon */}
          <button
            onClick={() => setModalOpen(true)}
            className="p-0.5 rounded hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
            title="설정"
          >
            <Settings className="size-3.5" />
          </button>

          {/* Git branch placeholder */}
          <div className="flex items-center gap-1 ml-1 text-text-muted">
            <GitBranch className="size-3" />
            <span>main</span>
          </div>
        </div>
      </div>

      <SettingsModal />
    </>
  )
}
