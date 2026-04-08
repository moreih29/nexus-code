import type { ReactNode } from 'react'
import { useLayoutStore } from '../../stores/layout-store'
import { HealthWarningBanner } from './health-warning-banner'
import { ResizeHandle } from './resize-handle'
import { StatusBar } from './status-bar'

interface AppLayoutProps {
  left?: ReactNode
  center?: ReactNode
  right?: ReactNode
}

export function AppLayout({ left, center, right }: AppLayoutProps) {
  const { rightPanelMode, rightPanelWidth, setRightPanelMode } = useLayoutStore()

  const resolvedRightWidth =
    rightPanelMode === 'collapsed'
      ? 0
      : rightPanelMode === 'expanded'
        ? Math.round(window.innerWidth * 0.55)
        : rightPanelWidth

  const gridCols = `220px 1fr ${resolvedRightWidth}px`

  return (
    <div
      className="h-screen overflow-hidden"
      style={{ display: 'grid', gridTemplateColumns: gridCols, gridTemplateRows: '1fr 28px' }}
    >
      {/* Left — workspace nav */}
      <div className="bg-bg-surface border-r border-border flex flex-col overflow-hidden row-span-2">
        {left ?? (
          <div className="flex flex-col h-full items-center justify-center text-text-muted text-xs">
            <span>워크스페이스 목록</span>
          </div>
        )}
      </div>

      {/* Center — chat area */}
      <div className="bg-bg-base flex flex-col overflow-hidden min-w-0">
        <HealthWarningBanner />
        {center ?? (
          <div className="flex flex-col h-full items-center justify-center text-text-muted text-xs gap-2">
            <span>채팅 영역</span>
            <div className="flex gap-2">
              <button
                className="px-2 py-1 rounded text-xs bg-bg-surface border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                onClick={() =>
                  setRightPanelMode(rightPanelMode === 'collapsed' ? 'normal' : 'collapsed')
                }
              >
                {rightPanelMode === 'collapsed' ? '패널 열기' : '패널 접기'}
              </button>
              <button
                className="px-2 py-1 rounded text-xs bg-bg-surface border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                onClick={() =>
                  setRightPanelMode(rightPanelMode === 'expanded' ? 'normal' : 'expanded')
                }
              >
                {rightPanelMode === 'expanded' ? '일반 폭' : '패널 확장'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Right — detail panel */}
      <div
        className="bg-bg-surface border-l border-border flex flex-col overflow-hidden row-span-2 relative transition-all duration-300"
        style={{ width: `${resolvedRightWidth}px` }}
      >
        {resolvedRightWidth > 0 && (
          <>
            <ResizeHandle />
            {right ?? (
              <div className="flex flex-col h-full items-center justify-center text-text-muted text-xs">
                <span>우측 패널</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* Status bar — spans center + right columns */}
      <StatusBar />
    </div>
  )
}
