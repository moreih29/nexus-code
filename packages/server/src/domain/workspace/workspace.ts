import { type Result, type AppError, ok, err, appError } from '@nexus/shared'
import type { Agent } from '../agent/agent.js'

export interface WorkspaceConfig {
  [key: string]: unknown
}

export interface WorkspaceProps {
  id: string
  path: string
  name?: string
  config?: WorkspaceConfig
}

export class Workspace {
  readonly id: string
  readonly path: string
  readonly name: string | undefined
  readonly config: WorkspaceConfig
  private _agents: Map<string, Agent>

  constructor(props: WorkspaceProps) {
    this.id = props.id
    this.path = props.path
    this.name = props.name
    this.config = props.config ?? {}
    this._agents = new Map()
  }

  addAgent(agent: Agent): Result<void, AppError> {
    if (agent.workspacePath !== this.path) {
      return err(
        appError(
          'AGENT_WORKSPACE_MISMATCH',
          `Agent ${agent.id} belongs to workspace '${agent.workspacePath}', not '${this.path}'`,
        ),
      )
    }
    if (this._agents.has(agent.id)) {
      return err(
        appError('AGENT_ALREADY_EXISTS', `Agent ${agent.id} already exists in workspace ${this.path}`),
      )
    }
    this._agents.set(agent.id, agent)
    return ok(undefined)
  }

  removeAgent(agentId: string): Result<void, AppError> {
    if (!this._agents.has(agentId)) {
      return err(
        appError('AGENT_NOT_FOUND', `Agent ${agentId} not found in workspace ${this.path}`),
      )
    }
    this._agents.delete(agentId)
    return ok(undefined)
  }

  getAgent(agentId: string): Result<Agent, AppError> {
    const agent = this._agents.get(agentId)
    if (!agent) {
      return err(
        appError('AGENT_NOT_FOUND', `Agent ${agentId} not found in workspace ${this.path}`),
      )
    }
    return ok(agent)
  }

  listAgents(): Result<Agent[], AppError> {
    return ok(Array.from(this._agents.values()))
  }
}
