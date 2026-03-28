import { useState } from 'react'
import { usePanelData } from '../../stores/plugin-store'
import type { AgentTimelineData, AgentToolEvent } from '../../../shared/types'

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
        isError ? 'bg-red-900/20' : isRunning ? 'bg-blue-900/10' : 'hover:bg-muted/40',
      ].join(' ')}
    >
      {/* 상태 인디케이터 */}
      <span
        className={[
          'mt-0.5 h-2 w-2 shrink-0 rounded-full',
          isRunning ? 'animate-pulse bg-blue-400' : isError ? 'bg-red-400' : 'bg-green-500',
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

function AgentCard({
  agent,
  activeFilters,
}: {
  agent: AgentTimelineData['agents'][number]
  activeFilters: Set<string>
}) {
  const filteredEvents =
    activeFilters.size === 0
      ? agent.events
      : agent.events.filter((e) => activeFilters.has(e.toolName))

  return (
    <div className="rounded border border-border bg-muted/30">
      {/* 헤더 */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span
          className={[
            'h-2 w-2 shrink-0 rounded-full',
            agent.status === 'running'
              ? 'animate-pulse bg-blue-400'
              : agent.status === 'error'
                ? 'bg-red-400'
                : 'bg-muted-foreground',
          ].join(' ')}
        />
        <span className="text-xs font-semibold text-blue-300">{agent.agentId}</span>
        <span className="ml-auto text-xs text-dim-foreground">{filteredEvents.length} calls</span>
      </div>
      {/* 이벤트 목록 */}
      <div className="divide-y divide-border">
        {filteredEvents.length === 0 ? (
          <p className="px-3 py-2 text-xs text-dim-foreground">도구 호출 없음</p>
        ) : (
          filteredEvents.map((e) => <ToolRow key={e.toolUseId} event={e} />)
        )}
      </div>
    </div>
  )
}

export function AgentTimeline() {
  const data = usePanelData<AgentTimelineData>('nexus', 'timeline')
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set())

  if (!data || data.agents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-xs text-dim-foreground">에이전트 활동 없음</span>
      </div>
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
      {/* 에이전트 목록 */}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
        {data.agents.map((agent) => (
          <AgentCard key={agent.agentId} agent={agent} activeFilters={activeFilters} />
        ))}
      </div>
    </div>
  )
}
