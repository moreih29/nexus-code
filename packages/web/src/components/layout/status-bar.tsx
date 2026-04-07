import { useState } from 'react'
import { Settings, ChevronDown, GitBranch } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { GlobalSettingsDialog } from '@/components/settings/global-settings-dialog'
import { MODELS, useSettingsStore, type ModelId, type PermissionMode } from '@/stores/settings-store'
import { useChatStore } from '@/stores/chat-store'
import { updateSessionSettings } from '@/api/settings'

const PERMISSION_MODES: { id: PermissionMode; label: string }[] = [
  { id: 'default', label: 'Default' },
  { id: 'auto', label: 'Auto' },
  { id: 'bypassPermissions', label: 'Bypass' },
]

export function StatusBar() {
  const [settingsOpen, setSettingsOpen] = useState(false)

  const { defaultModel, defaultPermissionMode, setDefaultModel, setDefaultPermissionMode } =
    useSettingsStore()
  const sessionId = useChatStore((s) => s.sessionId)

  const currentModelLabel =
    MODELS.find((m) => m.id === defaultModel)?.label ?? defaultModel
  const currentPermLabel =
    PERMISSION_MODES.find((m) => m.id === defaultPermissionMode)?.label ?? defaultPermissionMode

  function handleModelChange(modelId: ModelId) {
    setDefaultModel(modelId)
    if (sessionId) {
      updateSessionSettings(sessionId, { model: modelId }).catch((err) => {
        console.error('[settings] model update failed', err)
      })
    } else {
      console.log('[settings] model changed (no active session):', modelId)
    }
  }

  function handlePermissionChange(mode: PermissionMode) {
    setDefaultPermissionMode(mode)
    if (sessionId) {
      const apiMode = mode === 'default' ? undefined : mode
      updateSessionSettings(sessionId, { permissionMode: apiMode }).catch((err) => {
        console.error('[settings] permission mode update failed', err)
      })
    } else {
      console.log('[settings] permission mode changed (no active session):', mode)
    }
  }

  return (
    <>
      <div className="flex items-center justify-between px-3 h-7 bg-bg-surface border-t border-border text-xs text-text-muted select-none col-span-2">
        {/* Left side */}
        <div className="flex items-center gap-2">
          <span className="text-text-secondary">Nexus Code</span>
          <span className="mx-1 text-border">|</span>
          <span>준비</span>
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
                <span>{currentPermLabel}</span>
                <ChevronDown className="size-3 ml-0.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top">
              <DropdownMenuLabel>권한 모드</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {PERMISSION_MODES.map((m) => (
                <DropdownMenuItem
                  key={m.id}
                  onClick={() => handlePermissionChange(m.id)}
                  className={defaultPermissionMode === m.id ? 'text-[var(--accent)]' : ''}
                >
                  {m.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Settings icon */}
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-0.5 rounded hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
            title="전역 설정"
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

      <GlobalSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  )
}
