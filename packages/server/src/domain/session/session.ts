import type { AppError } from '@nexus/shared'
import type { Result } from '@nexus/shared'
import { ok, err, appError } from '@nexus/shared'

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'waiting_permission'
  | 'stopping'
  | 'stopped'
  | 'error'

export type PermissionMode = 'auto' | 'manual'

export interface SessionConfig {
  prompt: string
  model?: string
  permissionMode?: PermissionMode
}

export interface SessionProps {
  id: string
  workspacePath: string
  agentId: string
  status: SessionStatus
  startedAt: Date
  config: SessionConfig
}

const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  idle: ['running', 'error'],
  running: ['waiting_permission', 'stopping', 'stopped', 'error'],
  waiting_permission: ['running', 'stopping', 'error'],
  stopping: ['stopped', 'error'],
  stopped: [],
  error: [],
}

export class Session {
  readonly id: string
  readonly workspacePath: string
  readonly agentId: string
  private _status: SessionStatus
  readonly startedAt: Date
  readonly config: SessionConfig

  constructor(props: SessionProps) {
    this.id = props.id
    this.workspacePath = props.workspacePath
    this.agentId = props.agentId
    this._status = props.status
    this.startedAt = props.startedAt
    this.config = props.config
  }

  get status(): SessionStatus {
    return this._status
  }

  updateStatus(newStatus: SessionStatus): Result<void, AppError> {
    const allowed = VALID_TRANSITIONS[this._status]
    if (!allowed.includes(newStatus)) {
      return err(
        appError(
          'INVALID_SESSION_STATUS_TRANSITION',
          `Cannot transition session ${this.id} from '${this._status}' to '${newStatus}'`,
        ),
      )
    }
    this._status = newStatus
    return ok(undefined)
  }

  toSnapshot(): SessionProps {
    return {
      id: this.id,
      workspacePath: this.workspacePath,
      agentId: this.agentId,
      status: this._status,
      startedAt: this.startedAt,
      config: this.config,
    }
  }
}
