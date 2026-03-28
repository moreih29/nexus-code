import { EventEmitter } from 'events'
import { BrowserWindow } from 'electron'
import { IpcChannel } from '../../shared/ipc'
import type { PluginDataEvent, AgentToolEvent, AgentNode, AgentTimelineData } from '../../shared/types'
import log from '../logger'

export type { AgentToolEvent, AgentNode, AgentTimelineData }

// main agent의 고정 agentId
const MAIN_AGENT_ID = 'main'

interface SessionData {
  agents: Map<string, AgentNode>
  pendingTools: Map<string, { agentId: string; startMs: number }>
}

export class AgentTracker extends EventEmitter {
  private sessions = new Map<string, SessionData>()

  private getOrCreateSession(sessionId: string): SessionData {
    let data = this.sessions.get(sessionId)
    if (!data) {
      data = { agents: new Map(), pendingTools: new Map() }
      this.sessions.set(sessionId, data)
    }
    return data
  }

  /** SubagentStart 훅 처리 */
  onSubagentStart(sessionId: string, agentId: string, agentType?: string): void {
    log.debug('[AgentTracker] subagent start:', sessionId, agentId, agentType)
    const { agents } = this.getOrCreateSession(sessionId)
    if (!agents.has(agentId)) {
      agents.set(agentId, {
        agentId,
        parentAgentId: MAIN_AGENT_ID,
        agentType,
        events: [],
        lastSeen: Date.now(),
        startedAt: Date.now(),
        status: 'running',
      })
    } else {
      const agent = agents.get(agentId)!
      agent.status = 'running'
      agent.startedAt = agent.startedAt ?? Date.now()
    }
    this.broadcast(sessionId)
  }

  /** SubagentStop 훅 처리 */
  onSubagentStop(sessionId: string, agentId: string): void {
    log.debug('[AgentTracker] subagent stop:', sessionId, agentId)
    const { agents } = this.getOrCreateSession(sessionId)
    const agent = agents.get(agentId)
    if (agent) {
      agent.status = 'stopped'
      agent.stoppedAt = Date.now()
      agent.lastSeen = Date.now()
    }
    this.broadcast(sessionId)
  }

  /** HookServer의 pre-tool-use 페이로드 처리 */
  onPreToolUse(sessionId: string, agentId: string, toolName: string, toolInput: Record<string, unknown>, toolUseId: string): void {
    log.debug('[AgentTracker] pre-tool-use:', sessionId, agentId, toolName)
    const { agents, pendingTools } = this.getOrCreateSession(sessionId)
    if (!agents.has(agentId)) {
      agents.set(agentId, { agentId, events: [], lastSeen: Date.now() })
    }

    const agent = agents.get(agentId)!
    const event: AgentToolEvent = {
      toolUseId,
      toolName,
      input: toolInput,
      timestamp: Date.now(),
    }
    agent.events.push(event)
    agent.lastSeen = Date.now()
    pendingTools.set(toolUseId, { agentId, startMs: Date.now() })

    this.broadcast(sessionId)
  }

  /** tool 실행 결과 처리 */
  onPostToolUse(sessionId: string, toolUseId: string, result: string, isError: boolean): void {
    const { agents, pendingTools } = this.getOrCreateSession(sessionId)
    const pending = pendingTools.get(toolUseId)
    if (!pending) return

    const agent = agents.get(pending.agentId)
    if (!agent) return

    const event = agent.events.find((e) => e.toolUseId === toolUseId)
    if (event) {
      event.result = result
      event.isError = isError
      event.durationMs = Date.now() - pending.startMs
    }

    pendingTools.delete(toolUseId)
    this.broadcast(sessionId)
  }

  /** 세션 데이터 정리 */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  reset(): void {
    this.sessions.clear()
    // broadcast 없음 — 세션이 없으므로 불필요
  }

  private computeStatus(sessionId: string, agentId: string): 'idle' | 'running' | 'error' | 'stopped' {
    const data = this.sessions.get(sessionId)
    if (!data) return 'idle'
    const agent = data.agents.get(agentId)
    // SubagentStop으로 명시적으로 중단된 경우
    if (agent?.stoppedAt !== undefined) return 'stopped'
    for (const { agentId: id } of data.pendingTools.values()) {
      if (id === agentId) return 'running'
    }
    if (agent && agent.events.length > 0) {
      const last = agent.events[agent.events.length - 1]
      if (last.isError) return 'error'
    }
    return 'idle'
  }

  getTimelineData(sessionId: string): AgentTimelineData {
    const data = this.sessions.get(sessionId)
    if (!data) return { agents: [] }
    return {
      agents: Array.from(data.agents.values())
        .sort((a, b) => a.lastSeen - b.lastSeen)
        .map((agent) => ({ ...agent, status: this.computeStatus(sessionId, agent.agentId) })),
    }
  }

  private broadcast(sessionId: string): void {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return

    const event: PluginDataEvent = {
      pluginId: 'nexus',
      panelId: 'timeline',
      data: this.getTimelineData(sessionId),
      sessionId,
    }
    win.webContents.send(IpcChannel.PLUGIN_DATA, event)
  }
}
