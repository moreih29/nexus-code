import { useEffect, useState } from 'react'
import { BarChart3, List } from 'lucide-react'
import { cn } from '../../lib/utils'
import { AgentTimeline } from '../plugins/AgentTimeline'
import { GanttTimeline } from '../agent/GanttTimeline'

type BottomTab = 'timeline' | 'terminal' | 'problems'
type TimelineView = 'gantt' | 'card'

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

export function BottomPanel({ visible, onVisibleChange }: BottomPanelProps) {
  const [activeTab, setActiveTab] = useState<BottomTab>('timeline')
  const [timelineView, setTimelineView] = useState<TimelineView>('gantt')

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
    <div className="flex h-full flex-col border-t border-border bg-card">
      {/* 탭 바 */}
      <div className="flex h-9 shrink-0 items-center border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'flex h-full items-center px-4 text-xs transition-colors',
              activeTab === tab.id
                ? 'border-b-2 border-b-primary font-semibold text-primary'
                : 'font-medium text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}

        {/* Timeline 탭일 때 카드/간트 전환 */}
        {activeTab === 'timeline' && (
          <div className="ml-auto flex items-center gap-0.5 px-2">
            <button
              onClick={() => setTimelineView('gantt')}
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded transition-colors',
                timelineView === 'gantt'
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted',
              )}
              title="타임라인 뷰"
            >
              <BarChart3 size={13} />
            </button>
            <button
              onClick={() => setTimelineView('card')}
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded transition-colors',
                timelineView === 'card'
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted',
              )}
              title="카드 뷰"
            >
              <List size={13} />
            </button>
          </div>
        )}
      </div>

      {/* 탭 콘텐츠 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'timeline' && (
          timelineView === 'gantt' ? <GanttTimeline /> : <AgentTimeline />
        )}
        {activeTab === 'terminal' && <TerminalContent />}
        {activeTab === 'problems' && <ProblemsContent />}
      </div>
    </div>
  )
}
