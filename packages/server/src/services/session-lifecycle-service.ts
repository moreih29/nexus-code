import { randomUUID } from 'node:crypto'
import { ok, err } from '@nexus/shared'
import type { Result } from '@nexus/shared'
import type { ProcessSupervisor } from '../adapters/cli/process-supervisor.js'
import type { WorkspaceRegistry } from '../domain/workspace/workspace-registry.js'
import type { SessionStore } from '../adapters/db/session-store.js'
import type { HookManager } from '../adapters/hooks/hook-manager.js'
import type { SettingsStore, AppSettings } from '../adapters/db/settings-store.js'
import type { ApprovalPolicyStore } from '../adapters/db/approval-policy-store.js'
import type { WorkspaceGroup } from '../adapters/cli/workspace-group.js'
import type { CliProcess, CliStartOptions } from '../adapters/cli/cli-process.js'
// resolvePermissionMode는 ClaudeCodeHost(adapter)로 이관됨. 하위 호환성을 위해 re-export.
export type { PermissionModeInput } from '../adapters/claude-code-host.js'
export { resolvePermissionMode } from '../adapters/claude-code-host.js'

const LEGACY_MODEL_MAP: Record<string, string> = {
  'claude-opus-4-5': 'opus',
  'claude-sonnet-4-5': 'sonnet',
  'claude-haiku-4-5': 'haiku',
  'claude-opus-4-6': 'opus',
  'claude-sonnet-4-6': 'sonnet',
  'claude-haiku-4-6': 'haiku',
}

export function normalizeModel(model: string | null | undefined): string | undefined {
  if (!model) return undefined
  return LEGACY_MODEL_MAP[model] ?? model
}

/** CLI-relevant settings keys for comparison (excludes theme which is UI-only) */
const CLI_SETTINGS_KEYS = ['model', 'effortLevel', 'permissionMode', 'maxTurns', 'maxBudgetUsd', 'appendSystemPrompt', 'addDirs', 'disallowedTools', 'chromeEnabled'] as const

function pickCliSettings(s: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const k of CLI_SETTINGS_KEYS) {
    if (s[k] !== undefined) picked[k] = s[k]
  }
  return picked
}

export function settingsChanged(a: object, b: object): boolean {
  return JSON.stringify(pickCliSettings(a as Record<string, unknown>)) !== JSON.stringify(pickCliSettings(b as Record<string, unknown>))
}

export interface SessionRecord {
  id: string
  workspacePath: string
  agentId: string
  process: CliProcess
  createdAt: Date
  /** Settings the CLI process was started with */
  startedWithSettings?: object
}


export interface WireSessionProcessOpts {
  sessionId: string
  agentId: string
  workspacePath: string
  cliProcess: CliProcess
  store: SessionStore
  sessions: Map<string, SessionRecord>
  createdAt: Date
  settings?: object
  policyStore?: ApprovalPolicyStore
}

/** Wire a CLI process to session infrastructure: set meta, register event handlers, create record */
export function wireSessionProcess(opts: WireSessionProcessOpts): SessionRecord {
  const { sessionId, agentId, workspacePath, cliProcess, store, sessions, createdAt, settings, policyStore } = opts

  // Set meta BEFORE start() to avoid race condition with SSE events
  cliProcess.nexusSessionId = sessionId
  cliProcess.nexusAgentId = agentId

  cliProcess.on('init', (data) => {
    store.updateCliSessionId(sessionId, data.sessionId)
  })

  cliProcess.on('status_change', ({ status }) => {
    if (status === 'stopped' || status === 'error') {
      store.markEnded(sessionId, status === 'stopped' ? 0 : 1, status === 'error' ? 'Process exited with error' : null)
      policyStore?.deleteSessionRules(sessionId)
    } else {
      store.updateStatus(sessionId, status)
    }
  })

  const record: SessionRecord = {
    id: sessionId,
    workspacePath,
    agentId,
    process: cliProcess,
    createdAt,
    startedWithSettings: settings ? { ...settings } : undefined,
  }
  sessions.set(sessionId, record)
  return record
}

export interface WireAndStartOpts {
  sessionId: string
  workspacePath: string
  createdAt: Date
  startOpts: Omit<CliStartOptions, 'cwd'>
  settings?: object
}

export interface WireAndStartResult {
  record: SessionRecord
  agentId: string
  group: WorkspaceGroup
}

export class SessionLifecycleService {
  constructor(
    private readonly supervisor: ProcessSupervisor,
    private readonly registry: WorkspaceRegistry,
    private readonly sessions: Map<string, SessionRecord>,
    private readonly store: SessionStore,
    private readonly hookManager?: HookManager,
    private readonly settingsStore?: SettingsStore,
    private readonly policyStore?: ApprovalPolicyStore,
  ) {}

  /** Returns an existing group or creates one. Returns an error result if creation fails. */
  ensureGroup(workspacePath: string): Result<WorkspaceGroup> {
    const existing = this.supervisor.getGroup(workspacePath)
    if (existing) return ok(existing)

    const groupResult = this.supervisor.createGroup(workspacePath)
    if (!groupResult.ok) return err(groupResult.error)
    return ok(groupResult.value)
  }

  /** Validates the workspace path via registry. */
  validateWorkspace(workspacePath: string): Result<void> {
    const wsResult = this.registry.get(workspacePath)
    if (!wsResult.ok) return err(wsResult.error)
    return ok(undefined)
  }

  /** Injects hooks for the workspace if hookManager is present. */
  async injectHooks(workspacePath: string): Promise<void> {
    if (this.hookManager) {
      await this.hookManager.injectHooks(workspacePath)
    }
  }

  /** Returns effective settings for a workspace path. */
  getEffectiveSettings(workspacePath: string): AppSettings {
    return this.settingsStore?.getEffectiveSettings(workspacePath) ?? {}
  }

  /**
   * Creates a new CLI process within the given group, wires it to session
   * infrastructure, and starts it. On failure, rolls back the process and
   * session record.
   */
  async wireAndStart(opts: WireAndStartOpts): Promise<Result<WireAndStartResult>> {
    const { sessionId, workspacePath, createdAt, startOpts, settings } = opts

    const groupResult = this.ensureGroup(workspacePath)
    if (!groupResult.ok) return err(groupResult.error)
    const group = groupResult.value

    const agentId = randomUUID()
    const processResult = group.createProcess(agentId)
    if (!processResult.ok) return err(processResult.error)

    const cliProcess = processResult.value

    const record = wireSessionProcess({
      sessionId,
      agentId,
      workspacePath,
      cliProcess,
      store: this.store,
      sessions: this.sessions,
      createdAt,
      settings,
      policyStore: this.policyStore,
    })

    const startResult = await cliProcess.start({ cwd: workspacePath, ...startOpts })
    if (!startResult.ok) {
      group.removeProcess(agentId)
      this.sessions.delete(sessionId)
      return err(startResult.error)
    }

    return ok({ record, agentId, group })
  }

  /** Removes an existing tracked session's process before replacing it. */
  disposeExisting(sessionId: string): void {
    const existing = this.sessions.get(sessionId)
    if (!existing) return
    const group = this.supervisor.getGroup(existing.workspacePath)
    if (group) {
      group.removeProcess(existing.agentId)
    }
    this.sessions.delete(sessionId)
  }
}
