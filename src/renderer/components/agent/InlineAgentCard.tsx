import { useState } from 'react'
import { ChevronRight, ChevronDown, Activity } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { AgentNode, AgentToolEvent } from '../../../shared/types'

// ─── 유틸 ─────────────────────────────────────────────────────────────────────

function statusDotCls(status: AgentNode['status']): string {
  if (status === 'running') return 'animate-pulse bg-primary'
  if (status === 'error') return 'bg-error'
  if (status === 'stopped') return 'bg-muted-foreground/40'
  return 'bg-success'
}

function agentLabel(agent: AgentNode): string {
  if (agent.label) return agent.label
  if (agent.agentId === 'main') return 'main'
  return agent.agentType ?? agent.agentId.slice(0, 12)
}

function runningCount(agents: AgentNode[]): number {
  return agents.filter((a) => a.status === 'running').length
}

// ─── 도구 호출 행 (최근 N건) ─────────────────────────────────────────────────

function ToolRowCompact({ event }: { event: AgentToolEvent }) {
  const isRunning = event.result === undefined
  const isError = event.isError === true
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs">
      <span
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          isRunning ? 'animate-pulse bg-primary' : isError ? 'bg-error' : 'bg-success',
        )}
      />
      <span className="font-mono text-muted-foreground">{event.toolName}</span>
      <span className="flex-1 truncate text-dim-foreground">
        {Object.entries(event.input)
          .slice(0, 1)
          .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 40)}`)
          .join('')}
      </span>
    </div>
  )
}

// ─── 에이전트별 카드 (펼친 상태) ─────────────────────────────────────────────

function AgentDetailCard({ agent }: { agent: AgentNode }) {
  const recentEvents = agent.events.slice(-3)
  const label = agentLabel(agent)

  return (
    <div
      className={cn(
        'rounded border border-border bg-muted/20 p-2',
        agent.agentId !== 'main' && 'ml-3 border-l-2 border-l-primary/30',
      )}
    >
      {/* 헤더 */}
      <div className="flex items-center gap-2">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', statusDotCls(agent.status))} />
        <span className="text-xs font-semibold text-primary">{label}</span>
        {agent.currentTask && (
          <span className="truncate text-xs text-dim-foreground">{agent.currentTask}</span>
        )}
        <span className="ml-auto shrink-0 text-xs text-dim-foreground">
          {agent.events.length}건
        </span>
      </div>

      {/* 최근 도구 호출 3건 */}
      {recentEvents.length > 0 && (
        <div className="mt-1 pl-4">
          {recentEvents.map((e) => (
            <ToolRowCompact key={e.toolUseId} event={e} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── InlineAgentCard ──────────────────────────────────────────────────────────

interface InlineAgentCardProps {
  agents: AgentNode[]
  /** BottomPanel 열기 콜백 */
  onOpenTimeline?: () => void
}

export function InlineAgentCard({ agents, onOpenTimeline }: InlineAgentCardProps) {
  const [expanded, setExpanded] = useState(false)

  if (agents.length === 0) return null

  const running = runningCount(agents)
  const total = agents.length
  const progress = total > 0 ? ((total - running) / total) * 100 : 100
  const allDone = running === 0

  // 에이전트 이름 나열 (최대 3개)
  const names = agents
    .slice(0, 3)
    .map(agentLabel)
    .join(', ') + (agents.length > 3 ? ` 외 ${agents.length - 3}` : '')

  return (
    <div className="my-1 rounded-lg border border-border bg-card text-xs">
      {/* ─── 접힌 상태: 한 줄 요약 ─────────────────────────────────────── */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/30 transition-colors rounded-lg"
      >
        {/* 토글 아이콘 */}
        {expanded
          ? <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
          : <ChevronRight size={12} className="shrink-0 text-muted-foreground" />
        }

        {/* 에이전트 아이콘 */}
        <Activity size={12} className="shrink-0 text-primary" />

        {/* 요약 텍스트 */}
        <span className="text-muted-foreground">
          에이전트 {total}명
          {running > 0 && <span className="ml-1 text-primary animate-pulse">({running}명 실행 중)</span>}
        </span>

        {/* 에이전트 이름 나열 */}
        <span className="flex-1 truncate text-dim-foreground">{names}</span>

        {/* 진행률 바 */}
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                allDone ? 'bg-success' : 'bg-primary',
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
          {/* 상태 dot */}
          {agents.map((a) => (
            <span
              key={a.agentId}
              className={cn('h-1.5 w-1.5 rounded-full', statusDotCls(a.status))}
              title={agentLabel(a)}
            />
          ))}
        </div>
      </button>

      {/* ─── 펼친 상태: 에이전트별 카드 ──────────────────────────────────── */}
      {expanded && (
        <div className="border-t border-border px-3 pb-2 pt-2">
          <div className="flex flex-col gap-1.5">
            {agents.map((agent) => (
              <AgentDetailCard key={agent.agentId} agent={agent} />
            ))}
          </div>

          {/* [타임라인] 링크 */}
          {onOpenTimeline && (
            <button
              onClick={onOpenTimeline}
              className="mt-2 text-xs text-primary hover:underline"
            >
              전체 타임라인 보기 →
            </button>
          )}
        </div>
      )}
    </div>
  )
}
