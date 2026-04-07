import { type Result, type AppError, ok, err, appError } from '@nexus/shared'

export type AgentStatus =
  | 'idle'
  | 'running'
  | 'waiting_permission'
  | 'stopping'
  | 'stopped'
  | 'error'

// Valid state transitions
const VALID_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  idle: ['running', 'error'],
  running: ['waiting_permission', 'stopping', 'stopped', 'error'],
  waiting_permission: ['running', 'stopping', 'error'],
  stopping: ['stopped', 'error'],
  stopped: ['idle', 'running'],
  error: ['idle'],
}

export interface AgentProps {
  id: string
  type: string
  status: AgentStatus
  workspacePath: string
}

export class Agent {
  readonly id: string
  readonly type: string
  private _status: AgentStatus
  readonly workspacePath: string

  constructor(props: AgentProps) {
    this.id = props.id
    this.type = props.type
    this._status = props.status
    this.workspacePath = props.workspacePath
  }

  get status(): AgentStatus {
    return this._status
  }

  updateStatus(newStatus: AgentStatus): Result<void, AppError> {
    const allowed = VALID_TRANSITIONS[this._status]
    if (!allowed.includes(newStatus)) {
      return err(
        appError(
          'INVALID_STATUS_TRANSITION',
          `Cannot transition agent ${this.id} from '${this._status}' to '${newStatus}'`,
        ),
      )
    }
    this._status = newStatus
    return ok(undefined)
  }

  toSnapshot(): AgentProps {
    return {
      id: this.id,
      type: this.type,
      status: this._status,
      workspacePath: this.workspacePath,
    }
  }
}
