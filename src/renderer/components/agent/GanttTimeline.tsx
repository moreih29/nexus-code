import { useEffect, useMemo, useState } from 'react'
import { Activity } from 'lucide-react'
import { usePanelData } from '../../stores/plugin-store'
import { cn } from '../../lib/utils'
import { EmptyState } from '../ui/empty-state'
import type { AgentTimelineData, AgentNode, AgentToolEvent, AgentMessage } from '../../../shared/types'

// ─── 유틸 ────────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTime(ts: number, origin: number): string {
  const sec = (ts - origin) / 1000
  return `${sec.toFixed(1)}s`
}

// ─── 트리 플래튼 ──────────────────────────────────────────────────────────────

interface FlatAgent {
  agent: AgentNode
  depth: number
}

function flattenTree(agents: AgentNode[]): FlatAgent[] {
  const childMap = new Map<string, AgentNode[]>()
  const roots: AgentNode[] = []

  for (const a of agents) {
    if (a.parentAgentId && agents.some((p) => p.agentId === a.parentAgentId)) {
      const children = childMap.get(a.parentAgentId) ?? []
      children.push(a)
      childMap.set(a.parentAgentId, children)
    } else {
      roots.push(a)
    }
  }

  const result: FlatAgent[] = []
  function walk(node: AgentNode, depth: number) {
    result.push({ agent: node, depth })
    const children = childMap.get(node.agentId) ?? []
    for (const child of children) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  return result
}

// ─── 시간 스케일 ──────────────────────────────────────────────────────────────

const CHART_WIDTH = 800  // 기본 차트 너비 (px), overflow-x-auto로 스크롤
const ROW_HEIGHT = 28
const LABEL_WIDTH = 120

function timeToX(ts: number, origin: number, scale: number): number {
  return ((ts - origin) / 1000) * scale
}

// ─── 간트 바 ──────────────────────────────────────────────────────────────────

function GanttBar({
  event,
  origin,
  scale,
  status,
}: {
  event: AgentToolEvent
  origin: number
  scale: number
  status: AgentNode['status']
}) {
  const x = timeToX(event.timestamp, origin, scale)
  const width = event.durationMs != null
    ? Math.max((event.durationMs / 1000) * scale, 4)
    : 12 // running 상태: 최소 너비

  const bgClass = event.isError
    ? 'bg-destructive/70'
    : event.durationMs == null
      ? 'bg-primary animate-pulse'
      : status === 'error'
        ? 'bg-destructive/50'
        : 'bg-primary/50'

  return (
    <div
      className={cn('absolute top-1 h-4 rounded-sm', bgClass)}
      style={{ left: `${x}px`, width: `${width}px` }}
      title={`${event.toolName} ${event.durationMs != null ? formatDuration(event.durationMs) : '실행 중...'}`}
    >
      {width > 40 && (
        <span className="truncate px-1 text-[10px] leading-4 text-primary-foreground">
          {event.toolName}
        </span>
      )}
    </div>
  )
}

// ─── 에이전트 행 ──────────────────────────────────────────────────────────────

function AgentRow({
  agent,
  depth,
  origin,
  scale,
  now,
  isSelected,
  onClick,
}: {
  agent: AgentNode
  depth: number
  origin: number
  scale: number
  now: number
  isSelected: boolean
  onClick: () => void
}) {
  const label = agent.label ?? agent.agentType ?? agent.agentId.slice(0, 8)
  const startX = agent.startedAt ? timeToX(agent.startedAt, origin, scale) : 0
  const endTs = agent.stoppedAt ?? (agent.status === 'running' ? now : agent.lastSeen)
  const endX = timeToX(endTs, origin, scale)
  const barWidth = Math.max(endX - startX, 2)

  // 상태 dot
  const dotClass = agent.status === 'running'
    ? 'bg-primary animate-pulse'
    : agent.status === 'error'
      ? 'bg-destructive'
      : agent.status === 'stopped'
        ? 'bg-muted-foreground/40'
        : 'bg-muted-foreground'

  return (
    <div
      className={cn(
        'flex shrink-0 cursor-pointer border-b border-border transition-colors',
        isSelected ? 'bg-primary/8' : 'hover:bg-muted/30',
      )}
      style={{ height: `${ROW_HEIGHT}px` }}
      onClick={onClick}
    >
      {/* 라벨 */}
      <div
        className="flex shrink-0 items-center gap-1.5 border-r border-border px-2 text-xs"
        style={{ width: `${LABEL_WIDTH}px`, paddingLeft: `${8 + depth * 12}px` }}
      >
        <span className={cn('h-2 w-2 shrink-0 rounded-full', dotClass)} />
        <span className="truncate text-foreground">{label}</span>
      </div>

      {/* 차트 영역 */}
      <div className="relative min-w-0 flex-1">
        {/* 에이전트 수명 바 (배경) */}
        {agent.startedAt && (
          <div
            className="absolute top-2 h-2.5 rounded-sm bg-muted/50"
            style={{ left: `${startX}px`, width: `${barWidth}px` }}
          />
        )}

        {/* [MEET] 마커 */}
        {agent.teamId && agent.startedAt && (
          <div
            className="absolute top-0.5 text-[9px] font-bold text-warning"
            style={{ left: `${startX}px` }}
          >
            MEET
          </div>
        )}

        {/* 도구 호출 바 */}
        {agent.events.map((event) => (
          <GanttBar
            key={event.toolUseId}
            event={event}
            origin={origin}
            scale={scale}
            status={agent.status}
          />
        ))}
      </div>
    </div>
  )
}

// ─── 시간축 헤더 ──────────────────────────────────────────────────────────────

function TimeAxis({ totalSeconds, scale }: { totalSeconds: number; scale: number }) {
  const ticks: number[] = []
  const interval = totalSeconds <= 10 ? 1
    : totalSeconds <= 60 ? 5
    : totalSeconds <= 300 ? 30
    : 60

  for (let s = 0; s <= totalSeconds; s += interval) {
    ticks.push(s)
  }

  return (
    <div className="flex shrink-0 border-b border-border" style={{ height: '20px' }}>
      <div className="shrink-0" style={{ width: `${LABEL_WIDTH}px` }} />
      <div className="relative min-w-0 flex-1">
        {ticks.map((s) => (
          <span
            key={s}
            className="absolute top-0 text-[10px] text-dim-foreground"
            style={{ left: `${s * scale}px` }}
          >
            {s}s
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── 도구 호출 로그 ──────────────────────────────────────────────────────────

function ToolLog({
  agents,
  origin,
  selectedAgentId,
}: {
  agents: AgentNode[]
  origin: number
  selectedAgentId: string | null
}) {
  const allEvents = agents
    .flatMap((a) =>
      a.events.map((e) => ({
        ...e,
        agentLabel: a.label ?? a.agentType ?? a.agentId.slice(0, 8),
        agentId: a.agentId,
      })),
    )
    .filter((e) => !selectedAgentId || e.agentId === selectedAgentId)
    .sort((a, b) => a.timestamp - b.timestamp)

  if (allEvents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-dim-foreground">
        도구 호출 없음
      </div>
    )
  }

  return (
    <div className="overflow-y-auto text-xs">
      <table className="w-full">
        <thead className="sticky top-0 bg-card">
          <tr className="text-left text-dim-foreground">
            <th className="px-2 py-1 font-medium">시간</th>
            <th className="px-2 py-1 font-medium">에이전트</th>
            <th className="px-2 py-1 font-medium">도구</th>
            <th className="px-2 py-1 font-medium">대상</th>
            <th className="px-2 py-1 font-medium text-right">소요</th>
            <th className="px-2 py-1 font-medium text-center">상태</th>
          </tr>
        </thead>
        <tbody>
          {allEvents.map((e) => {
            const filePath = (e.input.file_path ?? e.input.path ?? e.input.command ?? '') as string
            const shortPath = typeof filePath === 'string' ? filePath.split('/').pop() ?? '' : ''
            const isRunning = e.durationMs == null
            const isError = e.isError === true

            return (
              <tr key={e.toolUseId} className="border-t border-border hover:bg-muted/20">
                <td className="px-2 py-1 font-mono text-dim-foreground">
                  {formatTime(e.timestamp, origin)}
                </td>
                <td className="px-2 py-1 text-primary">{e.agentLabel}</td>
                <td className="px-2 py-1 font-mono text-foreground">{e.toolName}</td>
                <td className="max-w-32 truncate px-2 py-1 text-muted-foreground">{shortPath}</td>
                <td className="px-2 py-1 text-right text-dim-foreground">
                  {isRunning ? '...' : formatDuration(e.durationMs!)}
                </td>
                <td className="px-2 py-1 text-center">
                  {isError ? (
                    <span className="text-destructive">✕</span>
                  ) : isRunning ? (
                    <span className="text-primary animate-pulse">●</span>
                  ) : (
                    <span className="text-success">✓</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── GanttTimeline ───────────────────────────────────────────────────────────

export function GanttTimeline() {
  const data = usePanelData<AgentTimelineData>('nexus', 'timeline')
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  // 1초 간격 갱신 (running 바 성장)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const agents = data?.agents ?? []
  const flatAgents = useMemo(() => flattenTree(agents), [agents])

  if (agents.length === 0) {
    return (
      <EmptyState
        size="sm"
        icon={<Activity className="h-full w-full" />}
        title="에이전트 활동 없음"
      />
    )
  }

  // 시간 범위 계산
  const allTimestamps = agents.flatMap((a) => [
    a.startedAt ?? Infinity,
    ...a.events.map((e) => e.timestamp),
    ...a.events.map((e) => e.durationMs != null ? e.timestamp + e.durationMs : -Infinity),
  ]).filter((t) => t !== Infinity && t !== -Infinity)

  const origin = Math.min(...allTimestamps)
  const latest = Math.max(...allTimestamps, now)
  const totalSeconds = Math.max(Math.ceil((latest - origin) / 1000), 5)

  // 스케일: 초당 픽셀 (최소 너비 보장)
  const scale = Math.max(CHART_WIDTH / totalSeconds, 20)
  const chartWidth = totalSeconds * scale

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 간트 차트 */}
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto" style={{ minWidth: `${LABEL_WIDTH + chartWidth}px` }}>
        <TimeAxis totalSeconds={totalSeconds} scale={scale} />
        {flatAgents.map(({ agent, depth }) => (
          <AgentRow
            key={agent.agentId}
            agent={agent}
            depth={depth}
            origin={origin}
            scale={scale}
            now={now}
            isSelected={selectedAgentId === agent.agentId}
            onClick={() => setSelectedAgentId(
              selectedAgentId === agent.agentId ? null : agent.agentId,
            )}
          />
        ))}
      </div>

      {/* 구분선 */}
      <div className="h-px shrink-0 bg-border" />

      {/* 하단 도구 호출 로그 */}
      <div className="h-1/3 shrink-0 overflow-hidden">
        <ToolLog agents={agents} origin={origin} selectedAgentId={selectedAgentId} />
      </div>
    </div>
  )
}
