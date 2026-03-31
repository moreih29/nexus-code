import { useEffect, useState } from 'react'
import { Command } from 'cmdk'
import { useActiveSession } from '../../stores/session-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useSettingsStore } from '../../stores/settings-store'
import type { ModelId } from '../../stores/settings-store'
import { MODEL_ALIASES } from '../../lib/models'

const EFFORT_LEVELS = ['auto', 'low', 'medium', 'high', 'max'] as const

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
  onOpenSettings: () => void
}

export function CommandPalette({ isOpen, onClose, onOpenSettings }: CommandPaletteProps) {
  const [search, setSearch] = useState('')

  const sessionId = useActiveSession((s) => s.sessionId)
  const status = useActiveSession((s) => s.status)
  const reset = useActiveSession((s) => s.reset)
  const { addWorkspace } = useWorkspaceStore()
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const updateSetting = useSettingsStore((s) => s.updateSetting)

  useEffect(() => {
    if (!isOpen) {
      setSearch('')
    }
  }, [isOpen])

  if (!isOpen) return null

  const handleSelect = (action: () => void) => {
    onClose()
    action()
  }

  const handleNewSession = () => {
    handleSelect(() => reset())
  }

  const handleOpenSettings = () => {
    handleSelect(() => onOpenSettings())
  }

  const handleRestartSession = () => {
    handleSelect(() => {
      if (sessionId) {
        reset()
      }
    })
  }

  const handleAddWorkspace = () => {
    handleSelect(() => addWorkspace())
  }

  const handleFocusSidebar = () => {
    handleSelect(() => {
      const sidebar = document.querySelector<HTMLElement>('[data-sidebar-sessions]')
      sidebar?.focus()
    })
  }

  // 워크스페이스 활성 시 project scope, 미활성 시 global scope
  const scope = activeWorkspace ? 'project' : 'global'

  const handleModelSwitch = (model: ModelId) => {
    handleSelect(() => updateSetting(scope, 'model', model))
  }

  const handleEffortSwitch = (effort: (typeof EFFORT_LEVELS)[number]) => {
    handleSelect(() => updateSetting(scope, 'effortLevel', effort))
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[560px] overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Command className="flex flex-col" shouldFilter={true}>
          <div className="border-b border-border px-4 py-3">
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder="명령어 검색..."
              className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              autoFocus
            />
          </div>

          <Command.List className="max-h-[360px] overflow-y-auto p-2">
            <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
              검색 결과 없음
            </Command.Empty>

            <Command.Group
              heading="세션"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
            >
              <Command.Item
                value="새 세션"
                onSelect={handleNewSession}
                className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground aria-selected:bg-accent"
              >
                <span className="text-base">+</span>
                <div>
                  <div className="font-medium">새 세션</div>
                  <div className="text-xs text-muted-foreground">현재 세션을 초기화하고 새로 시작</div>
                </div>
              </Command.Item>

              <Command.Item
                value="현재 세션 재시작"
                onSelect={handleRestartSession}
                disabled={!sessionId || status === 'running'}
                className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground aria-selected:bg-accent aria-disabled:opacity-40"
              >
                <span className="text-base">↺</span>
                <div>
                  <div className="font-medium">현재 세션 재시작</div>
                  <div className="text-xs text-muted-foreground">세션을 초기화하고 재시작</div>
                </div>
              </Command.Item>
            </Command.Group>

            <Command.Separator className="my-1 h-px bg-border" />

            <Command.Group
              heading="탐색"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
            >
              <Command.Item
                value="세션 히스토리"
                onSelect={handleFocusSidebar}
                className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground aria-selected:bg-accent"
              >
                <span className="text-base">☰</span>
                <div>
                  <div className="font-medium">세션 히스토리</div>
                  <div className="text-xs text-muted-foreground">사이드바 세션 목록으로 이동</div>
                </div>
              </Command.Item>
            </Command.Group>

            <Command.Separator className="my-1 h-px bg-border" />

            <Command.Group
              heading="워크스페이스"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
            >
              <Command.Item
                value="워크스페이스 추가"
                onSelect={handleAddWorkspace}
                className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground aria-selected:bg-accent"
              >
                <span className="text-base">⊕</span>
                <div>
                  <div className="font-medium">워크스페이스 추가</div>
                  <div className="text-xs text-muted-foreground">새 폴더를 워크스페이스로 추가</div>
                </div>
              </Command.Item>
            </Command.Group>

            <Command.Separator className="my-1 h-px bg-border" />

            <Command.Group
              heading="모델 전환"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
            >
              {(Object.entries(MODEL_ALIASES) as [ModelId, string][]).map(([modelId, alias]) => (
                <Command.Item
                  key={modelId}
                  value={`모델 ${alias} model ${alias}`}
                  onSelect={() => handleModelSwitch(modelId)}
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground aria-selected:bg-accent"
                >
                  <span className="text-base">◎</span>
                  <div>
                    <div className="font-medium">모델: {alias}</div>
                    <div className="text-xs text-muted-foreground">{modelId}</div>
                  </div>
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Separator className="my-1 h-px bg-border" />

            <Command.Group
              heading="Effort 전환"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
            >
              {EFFORT_LEVELS.map((effort) => (
                <Command.Item
                  key={effort}
                  value={`effort ${effort} 에포트`}
                  onSelect={() => handleEffortSwitch(effort)}
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground aria-selected:bg-accent"
                >
                  <span className="text-base">⚡</span>
                  <div>
                    <div className="font-medium">Effort: {effort}</div>
                  </div>
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Separator className="my-1 h-px bg-border" />

            <Command.Group
              heading="앱"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
            >
              <Command.Item
                value="설정 열기"
                onSelect={handleOpenSettings}
                className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground aria-selected:bg-accent"
              >
                <span className="text-base">⚙</span>
                <div>
                  <div className="font-medium">설정 열기</div>
                  <div className="text-xs text-muted-foreground">앱 설정 모달 열기</div>
                </div>
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  )
}
