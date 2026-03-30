import { useState } from 'react'
import { Activity } from 'lucide-react'
import { usePanelData } from '../../stores/plugin-store'
import type { AgentTimelineData, AgentToolEvent } from '../../../shared/types'
import { EmptyState } from '../ui/empty-state'

function formatDuration(ms?: number): string {
  if (ms === undefined) return '…'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function ToolRow({ event }: { event: AgentToolEvent }) {
  const isRunning = event.result === undefined
  const isError = event.isError === true

  return (
    <div
      className={[
        'flex items-start gap-2 rounded px-2 py-1 text-xs',
        isError ? 'bg-error/15' : isRunning ? 'bg-primary/10' : 'hover:bg-muted/40',
      ].join(' ')}
    >
      {/* 상태 인디케이터 */}
      <span
        className={[
          'mt-0.5 h-2 w-2 shrink-0 rounded-full',
          isRunning ? 'animate-pulse bg-primary' : isError ? 'bg-error' : 'bg-success',
        ].join(' ')}
      />
      {/* 타임스탬프 */}
      <span className="shrink-0 font-mono text-dim-foreground">{formatTimestamp(event.timestamp)}</span>
      {/* 도구 이름 */}
      <span className="font-mono text-foreground">{event.toolName}</span>
      {/* 입력 요약 */}
      <span className="flex-1 truncate text-muted-foreground">
        {Object.entries(event.input)
          .slice(0, 2)
          .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 30)}`)
          .join(' ')}
      </span>
      {/* 소요 시간 */}
      <span className="shrink-0 text-dim-foreground">{formatDuration(event.durationMs)}</span>
    </div>
  )
}

function statusDot(status: AgentTimelineData['agents'][number]['status']): string {
  if (status === 'running') return 'animate-pulse bg-primary'
  if (status === 'error') return 'bg-error'
  if (status === 'stopped') return 'bg-muted-foreground/40'
  return 'bg-muted-foreground'
}

function AgentCard({
  agent,
  activeFilters,
  children,
}: {
  agent: AgentTimelineData['agents'][number]
  activeFilters: Set<string>
  children?: React.ReactNode
}) {
  const filteredEvents =
    activeFilters.size === 0
      ? agent.events
      : agent.events.filter((e) => activeFilters.has(e.toolName))

  const isMain = agent.agentId === 'main'
  const label = isMain ? 'main' : (agent.agentType ?? agent.agentId)
  const subLabel = isMain ? null : agent.agentId.slice(0, 12)

  return (
    <div className={['rounded border border-border bg-muted/30', isMain ? '' : 'ml-4 border-l-2 border-l-primary/30'].join(' ')}>
      {/* 헤더 */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className={['h-2 w-2 shrink-0 rounded-full', statusDot(agent.status)].join(' ')} />
        <span className="text-xs font-semibold text-primary">{label}</span>
        {subLabel && (
          <span className="text-xs text-dim-foreground font-mono">{subLabel}</span>
        )}
        {agent.status === 'stopped' && (
          <span className="text-xs text-dim-foreground">(종료)</span>
        )}
        <span className="ml-auto text-xs text-dim-foreground">{filteredEvents.length}건 호출</span>
      </div>
      {/* 이벤트 목록 */}
      <div className="divide-y divide-border">
        {filteredEvents.length === 0 ? (
          <p className="px-3 py-2 text-xs text-dim-foreground">도구 호출 없음</p>
        ) : (
          filteredEvents.map((e) => <ToolRow key={e.toolUseId} event={e} />)
        )}
      </div>
      {/* 자식 에이전트 (중첩) */}
      {children && <div className="p-2">{children}</div>}
    </div>
  )
}

type AgentWithChildren = AgentTimelineData['agents'][number] & { children: AgentWithChildren[] }

function buildTree(agents: AgentTimelineData['agents']): AgentWithChildren[] {
  const map = new Map<string, AgentWithChildren>()
  for (const a of agents) {
    map.set(a.agentId, { ...a, children: [] })
  }
  const roots: AgentWithChildren[] = []
  for (const node of map.values()) {
    if (node.parentAgentId && map.has(node.parentAgentId)) {
      map.get(node.parentAgentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

function AgentTree({
  node,
  activeFilters,
}: {
  node: AgentWithChildren
  activeFilters: Set<string>
}) {
  return (
    <AgentCard agent={node} activeFilters={activeFilters}>
      {node.children.length > 0 && (
        <div className="flex flex-col gap-2">
          {node.children.map((child) => (
            <AgentTree key={child.agentId} node={child} activeFilters={activeFilters} />
          ))}
        </div>
      )}
    </AgentCard>
  )
}

export function AgentTimeline() {
  const data = usePanelData<AgentTimelineData>('nexus', 'timeline')
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set())

  if (!data || data.agents.length === 0) {
    return (
      <EmptyState
        size="sm"
        icon={<Activity className="h-full w-full" />}
        title="에이전트 활동 없음"
      />
    )
  }

  const allToolNames = Array.from(
    new Set(data.agents.flatMap((a) => a.events.map((e) => e.toolName))),
  ).sort()

  function toggleFilter(toolName: string) {
    setActiveFilters((prev) => {
      const next = new Set(prev)
      if (next.has(toolName)) {
        next.delete(toolName)
      } else {
        next.add(toolName)
      }
      return next
    })
  }

  const roots = buildTree(data.agents)

  return (
    <div className="flex h-full flex-col gap-0 overflow-hidden">
      {/* 필터 바 */}
      {allToolNames.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-border px-3 py-2">
          {allToolNames.map((name) => (
            <button
              key={name}
              onClick={() => toggleFilter(name)}
              className={[
                'rounded px-2 py-0.5 text-xs font-mono transition-colors',
                activeFilters.has(name)
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      {/* 에이전트 트리 */}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
        {roots.map((node) => (
          <AgentTree key={node.agentId} node={node} activeFilters={activeFilters} />
        ))}
      </div>
    </div>
  )
}
