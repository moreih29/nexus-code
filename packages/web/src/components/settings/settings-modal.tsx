import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useSettingsStore, type AppSettings, type CliSettings } from '@/stores/settings-store'
import { useActiveWorkspace } from '@/hooks/use-active-workspace'
import { cn } from '@/lib/utils'
import { AppTab } from './tabs/app-tab'
import { NexusTab } from './tabs/nexus-tab'
import { ClaudeCodeTab } from './tabs/claude-code-tab'
import { ScopeToggle } from './components/scope-toggle'

type Tab = 'app' | 'nexus' | 'claude-code'

export function SettingsModal() {
  const {
    modalOpen,
    setModalOpen,
    scope,
    setScope,
    projectSettings,
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

  const { workspace: activeWorkspace, workspacePath } = useActiveWorkspace()

  const [activeTab, setActiveTab] = useState<Tab>('app')
  const [permissionsText, setPermissionsText] = useState('')
  const [permissionsError, setPermissionsError] = useState('')

  const workspaceName = activeWorkspace
    ? (activeWorkspace.path.split('/').pop() ?? activeWorkspace.path)
    : null

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

  const draft = scope === 'global' ? draftGlobal : draftProject
  const draftCli = scope === 'global' ? draftGlobalCli : draftProjectCli

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
          <DialogHeader className="px-5 pt-4 pb-3 border-b border-[var(--border)] flex-shrink-0">
            <DialogTitle className="text-sm font-semibold text-[var(--text-primary)]">설정</DialogTitle>
          </DialogHeader>

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
              {showScopeToggle && (
                <ScopeToggle
                  scope={scope}
                  setScope={setScope}
                  workspacePath={workspacePath}
                  workspaceName={workspaceName}
                />
              )}

              <ScrollArea className="flex-1 min-h-0">
                {isLoading ? (
                  <div className="flex items-center justify-center h-32 text-xs text-[var(--text-muted)]">
                    불러오는 중...
                  </div>
                ) : (
                  <div className="px-5 py-4">
                    {activeTab === 'app' && <AppTab />}
                    {activeTab === 'nexus' && (
                      <NexusTab
                        scope={scope}
                        draft={draft}
                        globalDraft={draftGlobal}
                        projectSettings={projectSettings}
                        autoSave={autoSave}
                        updateDraft={updateDraft}
                        resetProjectKey={resetProjectKey}
                      />
                    )}
                    {activeTab === 'claude-code' && (
                      <ClaudeCodeTab
                        scope={scope}
                        draftCli={draftCli}
                        globalCliDraft={draftGlobalCli}
                        projectCliSettings={projectCliSettings}
                        permissionsText={permissionsText}
                        permissionsError={permissionsError}
                        onPermissionsTextChange={setPermissionsText}
                        onPermissionsBlur={handlePermissionsBlur}
                        updateDraftCli={updateDraftCli}
                      />
                    )}
                  </div>
                )}
              </ScrollArea>

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
