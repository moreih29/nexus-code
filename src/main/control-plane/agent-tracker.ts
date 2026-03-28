import { EventEmitter } from 'events'
import { BrowserWindow } from 'electron'
import { IpcChannel } from '../../shared/ipc'
import type { PluginDataEvent, AgentToolEvent, AgentNode, AgentTimelineData } from '../../shared/types'
import log from '../logger'

export type { AgentToolEvent, AgentNode, AgentTimelineData }

// main agent의 고정 agentId
const MAIN_AGENT_ID = 'main'

export class AgentTracker extends EventEmitter {
  private agents = new Map<string, AgentNode>()
  private pendingTools = new Map<string, { agentId: string; startMs: number }>()

  /** SubagentStart 훅 처리 */
  onSubagentStart(agentId: string, agentType?: string): void {
    log.debug('[AgentTracker] subagent start:', agentId, agentType)
    if (!this.agents.has(agentId)) {
      this.agents.set(agentId, {
        agentId,
        parentAgentId: MAIN_AGENT_ID,
        agentType,
        events: [],
        lastSeen: Date.now(),
        startedAt: Date.now(),
        status: 'running',
      })
    } else {
      const agent = this.agents.get(agentId)!
      agent.status = 'running'
      agent.startedAt = agent.startedAt ?? Date.now()
    }
    this.broadcast()
  }

  /** SubagentStop 훅 처리 */
  onSubagentStop(agentId: string): void {
    log.debug('[AgentTracker] subagent stop:', agentId)
    const agent = this.agents.get(agentId)
    if (agent) {
      agent.status = 'stopped'
      agent.stoppedAt = Date.now()
      agent.lastSeen = Date.now()
    }
    this.broadcast()
  }

  /** HookServer의 pre-tool-use 페이로드 처리 */
  onPreToolUse(agentId: string, toolName: string, toolInput: Record<string, unknown>, toolUseId: string): void {
    log.debug('[AgentTracker] pre-tool-use:', agentId, toolName)
    if (!this.agents.has(agentId)) {
      this.agents.set(agentId, { agentId, events: [], lastSeen: Date.now() })
    }

    const agent = this.agents.get(agentId)!
    const event: AgentToolEvent = {
      toolUseId,
      toolName,
      input: toolInput,
      timestamp: Date.now(),
    }
    agent.events.push(event)
    agent.lastSeen = Date.now()
    this.pendingTools.set(toolUseId, { agentId, startMs: Date.now() })

    this.broadcast()
  }

  /** tool 실행 결과 처리 */
  onPostToolUse(toolUseId: string, result: string, isError: boolean): void {
    const pending = this.pendingTools.get(toolUseId)
    if (!pending) return

    const agent = this.agents.get(pending.agentId)
    if (!agent) return

    const event = agent.events.find((e) => e.toolUseId === toolUseId)
    if (event) {
      event.result = result
      event.isError = isError
      event.durationMs = Date.now() - pending.startMs
    }

    this.pendingTools.delete(toolUseId)
    this.broadcast()
  }

  reset(): void {
    this.agents.clear()
    this.pendingTools.clear()
    this.broadcast()
  }

  private computeStatus(agentId: string): 'idle' | 'running' | 'error' | 'stopped' {
    const agent = this.agents.get(agentId)
    // SubagentStop으로 명시적으로 중단된 경우
    if (agent?.stoppedAt !== undefined) return 'stopped'
    for (const { agentId: id } of this.pendingTools.values()) {
      if (id === agentId) return 'running'
    }
    if (agent && agent.events.length > 0) {
      const last = agent.events[agent.events.length - 1]
      if (last.isError) return 'error'
    }
    return 'idle'
  }

  getTimelineData(): AgentTimelineData {
    return {
      agents: Array.from(this.agents.values())
        .sort((a, b) => a.lastSeen - b.lastSeen)
        .map((agent) => ({ ...agent, status: this.computeStatus(agent.agentId) })),
    }
  }

  private broadcast(): void {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return

    const event: PluginDataEvent = {
      pluginId: 'nexus',
      panelId: 'timeline',
      data: this.getTimelineData(),
    }
    win.webContents.send(IpcChannel.PLUGIN_DATA, event)
  }
}
