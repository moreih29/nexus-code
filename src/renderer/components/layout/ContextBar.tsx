import { X } from 'lucide-react'
import { useContextStore } from '../../stores/context-store'
import { usePanelData } from '../../stores/plugin-store'
import type { AgentTimelineData, AgentNode } from '../../../shared/types'

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

export function ContextBar() {
  const binding = useContextStore((s) => s.binding)
  const reset = useContextStore((s) => s.reset)
  const data = usePanelData<AgentTimelineData>('nexus', 'timeline')

  const { selectedAgentIds } = binding

  if (!selectedAgentIds || selectedAgentIds.length === 0) return null

  const selectedAgents = (data?.agents ?? []).filter((a) =>
    selectedAgentIds.includes(a.agentId),
  )

  return (
    <div className="flex items-center gap-2 border-b border-primary/20 bg-primary/8 px-3 py-1.5">
      <span className="text-xs text-muted-foreground">컨텍스트:</span>
      <div className="flex flex-1 flex-wrap items-center gap-1.5">
        {selectedAgents.length > 0
          ? selectedAgents.map((agent) => (
              <span
                key={agent.agentId}
                className="flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary"
              >
                <span className={`h-1.5 w-1.5 rounded-full ${statusDotCls(agent.status)}`} />
                {agentLabel(agent)}
              </span>
            ))
          : selectedAgentIds.map((id) => (
              <span
                key={id}
                className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary"
              >
                {id.slice(0, 12)}
              </span>
            ))}
      </div>
      <button
        onClick={reset}
        className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="컨텍스트 바인딩 해제"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
