import { type Result, type AppError, ok, err, appError } from '@nexus/shared'
import type { EventPort } from '../../ports/event-port.js'
import { Workspace, type WorkspaceProps } from './workspace.js'

export class WorkspaceRegistry {
  private _workspaces: Map<string, Workspace>
  private _events: EventPort

  constructor(events: EventPort) {
    this._workspaces = new Map()
    this._events = events
  }

  add(props: WorkspaceProps): Result<Workspace, AppError> {
    if (this._workspaces.has(props.path)) {
      return err(
        appError('WORKSPACE_ALREADY_EXISTS', `Workspace at path '${props.path}' already exists`),
      )
    }
    const workspace = new Workspace(props)
    this._workspaces.set(props.path, workspace)
    this._events.emit('workspace:added', { path: props.path, id: props.id })
    return ok(workspace)
  }

  remove(path: string): Result<void, AppError> {
    if (!this._workspaces.has(path)) {
      return err(
        appError('WORKSPACE_NOT_FOUND', `Workspace at path '${path}' not found`),
      )
    }
    this._workspaces.delete(path)
    this._events.emit('workspace:removed', { path })
    return ok(undefined)
  }

  get(path: string): Result<Workspace, AppError> {
    const workspace = this._workspaces.get(path)
    if (!workspace) {
      return err(
        appError('WORKSPACE_NOT_FOUND', `Workspace at path '${path}' not found`),
      )
    }
    return ok(workspace)
  }

  list(): Result<Workspace[], AppError> {
    return ok(Array.from(this._workspaces.values()))
  }
}
