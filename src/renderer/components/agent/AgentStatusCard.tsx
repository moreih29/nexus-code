import { memo } from 'react'
import { cn } from '../../lib/utils'
import type { AgentNode } from '../../../shared/types'

// ─── 유틸 ─────────────────────────────────────────────────────────────────────

function statusDotCls(status: AgentNode['status']): string {
  if (status === 'running') return 'animate-pulse bg-primary'
  if (status === 'error') return 'bg-error'
  if (status === 'stopped') return 'bg-muted-foreground/40'
  return 'bg-success'
}

function statusLabel(status: AgentNode['status']): string {
  if (status === 'running') return '실행 중'
  if (status === 'error') return '오류'
  if (status === 'stopped') return '종료'
  return 'idle'
}

function statusBadgeCls(status: AgentNode['status']): string {
  if (status === 'running') return 'bg-primary/15 text-primary'
  if (status === 'error') return 'bg-error/15 text-error'
  if (status === 'stopped') return 'bg-muted/60 text-muted-foreground'
  return 'bg-success/15 text-success'
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

export function agentLabel(agent: AgentNode): string {
  if (agent.label) return agent.label
  if (agent.agentId === 'main') return 'main'
  return agent.agentType ?? agent.agentId.slice(0, 12)
}

// ─── Props ─────────────────────────────────────────────────────────────────────

export interface AgentStatusCardProps {
  agent: AgentNode
  isSelected: boolean
  elapsedMs: number
  lastToolName: string | null
  changedFileCount: number
  onSelect: () => void
}

// ─── AgentStatusCard ──────────────────────────────────────────────────────────

export const AgentStatusCard = memo(function AgentStatusCard({
  agent,
  isSelected,
  elapsedMs,
  lastToolName,
  changedFileCount,
  onSelect,
}: AgentStatusCardProps) {
  const label = agentLabel(agent)
  const recentTools = agent.events.slice(-3)
  const status = agent.status ?? 'idle'

  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full rounded-lg border border-border bg-muted/20 p-2 text-xs text-left transition-colors',
        'hover:bg-muted/40',
        isSelected && 'border-l-2 border-l-primary bg-primary/8',
      )}
    >
      {/* Level 1: dot + 라벨 + 상태 badge */}
      <div className="flex items-center gap-1.5">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', statusDotCls(status))} />
        <span className="font-semibold text-foreground truncate flex-1">{label}</span>
        <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium', statusBadgeCls(status))}>
          {statusLabel(status)}
        </span>
        <span className="shrink-0 text-dim-foreground">{formatElapsed(elapsedMs)}</span>
      </div>

      {/* Level 2: currentTask (hover → group-hover로 항상 표시, CSS로 처리) */}
      {agent.currentTask && (
        <div className="mt-1 pl-3.5 truncate text-muted-foreground">{agent.currentTask}</div>
      )}

      {/* Level 3: 선택 시 최근 도구 3건 pill + 이벤트 수 */}
      {isSelected && (
        <div className="mt-2 pl-3.5">
          <div className="flex flex-wrap gap-1">
            {recentTools.map((e) => (
              <span
                key={e.toolUseId}
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {e.toolName}
              </span>
            ))}
          </div>
          <div className="mt-1 text-[10px] text-dim-foreground">
            이벤트 {agent.events.length}건
            {changedFileCount > 0 && ` · 파일 ${changedFileCount}개`}
          </div>
        </div>
      )}
    </button>
  )
},
  (prev, next) =>
    prev.isSelected === next.isSelected &&
    prev.elapsedMs === next.elapsedMs &&
    prev.lastToolName === next.lastToolName &&
    prev.changedFileCount === next.changedFileCount &&
    prev.agent.status === next.agent.status &&
    prev.agent.currentTask === next.agent.currentTask &&
    prev.agent.events.length === next.agent.events.length,
)
