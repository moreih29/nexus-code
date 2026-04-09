import { useState } from 'react'
import { useSettingsStore } from '../../stores/settings-store.js'
import { useActiveWorkspace } from '../../hooks/use-active-workspace.js'

export interface PermissionDenyBlockProps {
  toolName: string
  reason: string
  targetPath?: string
  source: 'mode' | 'rule'
}

export function PermissionDenyBlock({ toolName, reason, targetPath, source }: PermissionDenyBlockProps) {
  const [ignored, setIgnored] = useState(false)
  const { workspacePath } = useActiveWorkspace()

  function handleSwitchToAcceptEdits() {
    void useSettingsStore.getState().quickSave({ permissionMode: 'acceptEdits' }, workspacePath)
  }

  function handleIgnore() {
    setIgnored(true)
  }

  if (ignored) return null

  return (
    <div
      className="rounded-md p-2 text-xs"
      style={{
        background: 'rgba(248,81,73,0.05)',
        border: '1px solid rgba(248,81,73,0.30)',
      }}
    >
      {/* 헤더 */}
      <div className="flex items-center gap-1 mb-1">
        <span style={{ color: 'var(--color-red, #f85149)' }}>⊘</span>
        <span className="font-medium" style={{ color: 'var(--color-red, #f85149)' }}>
          차단됨 — {toolName} 도구
        </span>
      </div>

      {/* 이유 */}
      <div
        className="text-[10px] mb-1 line-clamp-1"
        style={{ color: 'var(--text-muted)' }}
        title={reason}
      >
        이유: {reason}
      </div>

      {/* 대상 경로 (선택적) */}
      {targetPath && (
        <div
          className="text-[10px] font-mono mb-2 line-clamp-1"
          style={{ color: 'var(--text-muted)' }}
          title={targetPath}
        >
          대상: {targetPath}
        </div>
      )}

      {/* source: rule일 때만 추가 안내 */}
      {source === 'rule' && (
        <div
          className="text-[10px] mb-2"
          style={{ color: 'var(--text-muted)' }}
        >
          규칙에 의해 차단됨
        </div>
      )}

      {/* CTA */}
      <div className="flex gap-1 mt-2">
        <button
          onClick={handleSwitchToAcceptEdits}
          className="flex-1 text-[10px] px-2 py-1 rounded transition-opacity hover:opacity-90"
          style={{
            background: 'var(--accent)',
            color: 'var(--bg-base)',
          }}
          title="이 변경은 유지됩니다. 계획 모드로 돌아가려면 수동 전환"
        >
          편집 허용으로 전환
        </button>
        <button
          onClick={handleIgnore}
          className="flex-1 text-[10px] px-2 py-1 rounded transition-colors"
          style={{
            background: 'var(--bg-hover)',
            color: 'var(--text-primary)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--bg-muted)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'var(--bg-hover)'
          }}
        >
          무시하고 계속
        </button>
      </div>
    </div>
  )
}
