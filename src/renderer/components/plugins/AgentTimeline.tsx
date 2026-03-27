import { usePanelData } from '../../stores/plugin-store'
import type { AgentTimelineData, AgentToolEvent } from '../../../shared/types'

function formatDuration(ms?: number): string {
  if (ms === undefined) return '…'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function ToolRow({ event }: { event: AgentToolEvent }) {
  const isRunning = event.result === undefined
  const isError = event.isError === true

  return (
    <div
      className={[
        'flex items-start gap-2 rounded px-2 py-1 text-xs',
        isError ? 'bg-red-900/20' : isRunning ? 'bg-blue-900/10' : 'hover:bg-gray-800/40',
      ].join(' ')}
    >
      {/* 상태 인디케이터 */}
      <span
        className={[
          'mt-0.5 h-2 w-2 shrink-0 rounded-full',
          isRunning ? 'animate-pulse bg-blue-400' : isError ? 'bg-red-400' : 'bg-green-500',
        ].join(' ')}
      />
      {/* 도구 이름 */}
      <span className="font-mono text-gray-200">{event.toolName}</span>
      {/* 입력 요약 */}
      <span className="flex-1 truncate text-gray-500">
        {Object.entries(event.input)
          .slice(0, 2)
          .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 30)}`)
          .join(' ')}
      </span>
      {/* 소요 시간 */}
      <span className="shrink-0 text-gray-600">{formatDuration(event.durationMs)}</span>
    </div>
  )
}

function AgentCard({ agent }: { agent: AgentTimelineData['agents'][number] }) {
  return (
    <div className="rounded border border-gray-700 bg-gray-800/30">
      {/* 헤더 */}
      <div className="flex items-center gap-2 border-b border-gray-700 px-3 py-1.5">
        <span className="text-xs font-semibold text-blue-300">{agent.agentId}</span>
        <span className="ml-auto text-xs text-gray-600">{agent.events.length} calls</span>
      </div>
      {/* 이벤트 목록 */}
      <div className="divide-y divide-gray-800">
        {agent.events.length === 0 ? (
          <p className="px-3 py-2 text-xs text-gray-600">도구 호출 없음</p>
        ) : (
          agent.events.map((e) => <ToolRow key={e.toolUseId} event={e} />)
        )}
      </div>
    </div>
  )
}

export function AgentTimeline() {
  const data = usePanelData<AgentTimelineData>('nexus', 'timeline')

  if (!data || data.agents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-xs text-gray-600">에이전트 활동 없음</span>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      {data.agents.map((agent) => (
        <AgentCard key={agent.agentId} agent={agent} />
      ))}
    </div>
  )
}
