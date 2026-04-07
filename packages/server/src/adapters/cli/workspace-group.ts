import { ok, err, appError } from '@nexus/shared'
import type { Result } from '@nexus/shared'
import { CliProcess } from './cli-process.js'
import type { CliStartOptions } from './cli-process.js'
import type { Disposable } from './disposable.js'

export type CliProcessFactory = (agentId: string) => CliProcess

type ProcessChangeHandler = (agentId: string, process_: CliProcess) => void

function defaultFactory(_agentId: string): CliProcess {
  return new CliProcess()
}

export class WorkspaceGroup implements Disposable {
  readonly workspacePath: string
  private readonly _processes: Map<string, CliProcess> = new Map()
  private readonly _maxProcesses: number
  private readonly _factory: CliProcessFactory
  private readonly _onProcessAdded: Set<ProcessChangeHandler> = new Set()
  private readonly _onProcessRemoved: Set<ProcessChangeHandler> = new Set()

  constructor(
    workspacePath: string,
    maxProcesses = 10,
    factory: CliProcessFactory = defaultFactory,
  ) {
    this.workspacePath = workspacePath
    this._maxProcesses = maxProcesses
    this._factory = factory
  }

  onProcessAdded(handler: ProcessChangeHandler): () => void {
    this._onProcessAdded.add(handler)
    return () => { this._onProcessAdded.delete(handler) }
  }

  onProcessRemoved(handler: ProcessChangeHandler): () => void {
    this._onProcessRemoved.add(handler)
    return () => { this._onProcessRemoved.delete(handler) }
  }

  createProcess(agentId: string, _options?: CliStartOptions): Result<CliProcess> {
    if (this._processes.has(agentId)) {
      return err(
        appError(
          'PROCESS_ALREADY_EXISTS',
          `Process for agent '${agentId}' already exists in workspace '${this.workspacePath}'`,
        ),
      )
    }

    if (this._processes.size >= this._maxProcesses) {
      return err(
        appError(
          'WORKSPACE_PROCESS_LIMIT',
          `Workspace '${this.workspacePath}' has reached the maximum of ${this._maxProcesses} processes`,
        ),
      )
    }

    const process_ = this._factory(agentId)
    this._processes.set(agentId, process_)
    for (const h of this._onProcessAdded) { h(agentId, process_) }
    return ok(process_)
  }

  removeProcess(agentId: string): void {
    const process_ = this._processes.get(agentId)
    if (process_) {
      for (const h of this._onProcessRemoved) { h(agentId, process_) }
      process_.dispose()
      this._processes.delete(agentId)
    }
  }

  getProcess(agentId: string): CliProcess | undefined {
    return this._processes.get(agentId)
  }

  listProcesses(): CliProcess[] {
    return Array.from(this._processes.values())
  }

  listProcessEntries(): [string, CliProcess][] {
    return Array.from(this._processes.entries())
  }

  getProcessCount(): number {
    return this._processes.size
  }

  dispose(): void {
    for (const process_ of this._processes.values()) {
      process_.dispose()
    }
    this._processes.clear()
  }
}
