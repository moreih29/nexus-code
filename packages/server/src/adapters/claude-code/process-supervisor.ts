import { ok, err, appError } from '@nexus/shared'
import type { Result } from '@nexus/shared'
import { WorkspaceGroup } from './workspace-group.js'
import type { CliProcessFactory } from './workspace-group.js'
import type { Disposable } from './disposable.js'

export class ProcessSupervisor implements Disposable {
  private readonly _groups: Map<string, WorkspaceGroup> = new Map()
  private readonly _maxGlobalProcesses: number
  private readonly _maxProcessesPerGroup: number
  private readonly _factory: CliProcessFactory | undefined

  constructor(
    maxGlobalProcesses = 30,
    maxProcessesPerGroup = 10,
    factory?: CliProcessFactory,
  ) {
    this._maxGlobalProcesses = maxGlobalProcesses
    this._maxProcessesPerGroup = maxProcessesPerGroup
    this._factory = factory
  }

  createGroup(workspacePath: string): Result<WorkspaceGroup> {
    if (this._groups.has(workspacePath)) {
      return err(
        appError(
          'GROUP_ALREADY_EXISTS',
          `Workspace group for '${workspacePath}' already exists`,
        ),
      )
    }

    const group = new WorkspaceGroup(
      workspacePath,
      this._maxProcessesPerGroup,
      this._factory,
    )
    this._groups.set(workspacePath, group)
    return ok(group)
  }

  removeGroup(workspacePath: string): void {
    const group = this._groups.get(workspacePath)
    if (group) {
      group.dispose()
      this._groups.delete(workspacePath)
    }
  }

  getGroup(workspacePath: string): WorkspaceGroup | undefined {
    return this._groups.get(workspacePath)
  }

  listGroups(): WorkspaceGroup[] {
    return Array.from(this._groups.values())
  }

  getGlobalProcessCount(): number {
    let total = 0
    for (const group of this._groups.values()) {
      total += group.getProcessCount()
    }
    return total
  }

  isGlobalLimitReached(): boolean {
    return this.getGlobalProcessCount() >= this._maxGlobalProcesses
  }

  createProcessInGroup(
    workspacePath: string,
    agentId: string,
  ): Result<import('./cli-process.js').CliProcess> {
    if (this.getGlobalProcessCount() >= this._maxGlobalProcesses) {
      return err(
        appError(
          'GLOBAL_PROCESS_LIMIT',
          `Global process limit of ${this._maxGlobalProcesses} has been reached`,
        ),
      )
    }

    const group = this._groups.get(workspacePath)
    if (!group) {
      return err(
        appError(
          'GROUP_NOT_FOUND',
          `Workspace group for '${workspacePath}' does not exist`,
        ),
      )
    }

    return group.createProcess(agentId)
  }

  dispose(): void {
    for (const group of this._groups.values()) {
      group.dispose()
    }
    this._groups.clear()
  }
}
