import { useEffect, useRef, useState } from 'react'
import { Activity } from 'lucide-react'
import { usePanelData } from '../../stores/plugin-store'
import { useContextStore } from '../../stores/context-store'
import type { AgentTimelineData, AgentNode } from '../../../shared/types'
import { EmptyState } from '../ui/empty-state'
import { AgentStatusCard, agentLabel } from './AgentStatusCard'

// ─── Props ─────────────────────────────────────────────────────────────────────

export interface AgentSidebarProps {
  sessionId: string | null
  onAgentSelect: (agentId: string) => void
}

// ─── 정렬: main 최상단, running 상단, 나머지 lastSeen 내림차순 ──────────────────

function sortAgents(agents: AgentNode[]): AgentNode[] {
  return [...agents].sort((a, b) => {
    if (a.agentId === 'main') return -1
    if (b.agentId === 'main') return 1
    if (a.status === 'running' && b.status !== 'running') return -1
    if (b.status === 'running' && a.status !== 'running') return 1
    return b.lastSeen - a.lastSeen
  })
}

// ─── 경과 시간 계산 ──────────────────────────────────────────────────────────

function calcElapsed(agent: AgentNode, now: number): number {
  const start = agent.startedAt ?? agent.lastSeen
  const end = agent.stoppedAt ?? now
  return Math.max(0, end - start)
}

// ─── 마지막 도구 이름 ─────────────────────────────────────────────────────────

function lastToolName(agent: AgentNode): string | null {
  if (agent.events.length === 0) return null
  return agent.events[agent.events.length - 1].toolName
}

// ─── 변경 파일 수 (Write/Edit 계열 도구 건수 근사) ──────────────────────────

function changedFileCount(agent: AgentNode): number {
  return agent.events.filter((e) =>
    ['Write', 'Edit', 'MultiEdit', 'str_replace_editor', 'create_file', 'write_file'].includes(e.toolName),
  ).length
}

// ─── AgentSidebar ─────────────────────────────────────────────────────────────

export function AgentSidebar({ onAgentSelect }: AgentSidebarProps) {
  const data = usePanelData<AgentTimelineData>('nexus', 'timeline')
  const selectedAgentIds = useContextStore((s) => s.binding.selectedAgentIds)

  // 1초 interval로 현재 시각 업데이트 (경과 시간 갱신)
  const [now, setNow] = useState(() => Date.now())
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    intervalRef.current = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [])

  const STOPPED_RETENTION_MS = 5 * 60 * 1000 // 5분

  const visibleAgents = data
    ? data.agents.filter((a) => {
        if (a.status !== 'stopped') return true
        if (!a.stoppedAt) return false
        return now - a.stoppedAt < STOPPED_RETENTION_MS
      })
    : []

  if (visibleAgents.length === 0) {
    return (
      <EmptyState
        size="sm"
        icon={<Activity className="h-full w-full" />}
        title="에이전트 없음"
      />
    )
  }

  const sorted = sortAgents(visibleAgents)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 에이전트 목록 */}
      <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto p-2">
        {sorted.map((agent) => (
          <AgentStatusCard
            key={agent.agentId}
            agent={agent}
            isSelected={selectedAgentIds?.includes(agent.agentId) ?? false}
            elapsedMs={calcElapsed(agent, now)}
            lastToolName={lastToolName(agent)}
            changedFileCount={changedFileCount(agent)}
            onSelect={() => onAgentSelect(agent.agentId)}
          />
        ))}
      </div>

    </div>
  )
}
