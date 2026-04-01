import { useEffect, useState } from 'react'
import { AgentTimeline } from '../plugins/AgentTimeline'

type BottomTab = 'timeline' | 'terminal' | 'problems'

const TABS: { id: BottomTab; label: string }[] = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'problems', label: 'Problems' },
]

interface BottomPanelProps {
  visible: boolean
  onVisibleChange: (visible: boolean) => void
  height?: number
}

function TerminalContent() {
  return (
    <div className="flex h-full items-center justify-center">
      <span className="text-xs text-dim-foreground">Bash 도구 출력 로그 — 준비 중</span>
    </div>
  )
}

function ProblemsContent() {
  return (
    <div className="flex h-full items-center justify-center">
      <span className="text-xs text-dim-foreground">타입 에러 목록 — 준비 중</span>
    </div>
  )
}

export function BottomPanel({ visible, onVisibleChange, height = 30 }: BottomPanelProps) {
  const [activeTab, setActiveTab] = useState<BottomTab>('timeline')

  // Cmd+J / Ctrl+J 토글
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const modKey = isMac ? e.metaKey : e.ctrlKey
      if (modKey && e.key === 'j') {
        e.preventDefault()
        onVisibleChange(!visible)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [visible, onVisibleChange])

  if (!visible) return null

  return (
    <div
      className="flex shrink-0 flex-col border-t border-border bg-card"
      style={{ height: `${height}%` }}
    >
      {/* 탭 바 */}
      <div className="flex h-9 shrink-0 items-center border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={[
              'flex h-full items-center px-4 text-xs transition-colors',
              activeTab === tab.id
                ? 'border-b-2 border-b-primary font-semibold text-primary'
                : 'font-medium text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 탭 콘텐츠 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'timeline' && <AgentTimeline />}
        {activeTab === 'terminal' && <TerminalContent />}
        {activeTab === 'problems' && <ProblemsContent />}
      </div>
    </div>
  )
}
