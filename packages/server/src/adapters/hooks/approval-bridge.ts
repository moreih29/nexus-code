import type { ApprovalPolicyStore } from '../db/approval-policy-store.js'
import type { SettingsStore } from '../db/settings-store.js'
import { type ToolCategory, categorizeClaudeCodeTool } from '../cli/tool-categorizer.js'

const APPROVAL_TIMEOUT_MS = 300_000

// ---------------------------------------------------------------------------
// Mode × Tool matrix
// ---------------------------------------------------------------------------

type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
type MatrixDecision = 'allow' | 'deny' | 'ask'

const MODE_TOOL_MATRIX: Record<PermissionMode, Record<ToolCategory, MatrixDecision>> = {
  default: {
    read: 'allow',
    edit: 'ask',
    'bash-fs': 'ask',
    'bash-other': 'ask',
    web: 'ask',
    task: 'allow',
    mcp: 'ask',
    unknown: 'ask',
  },
  acceptEdits: {
    read: 'allow',
    edit: 'allow',
    'bash-fs': 'allow',
    'bash-other': 'ask',
    web: 'ask',
    task: 'allow',
    mcp: 'ask',
    unknown: 'ask',
  },
  plan: {
    read: 'allow',
    edit: 'deny',
    'bash-fs': 'ask',
    'bash-other': 'ask',
    web: 'ask',
    task: 'allow',
    mcp: 'ask',
    unknown: 'ask',
  },
  bypassPermissions: {
    read: 'allow',
    edit: 'allow',
    'bash-fs': 'allow',
    'bash-other': 'allow',
    web: 'allow',
    task: 'allow',
    mcp: 'allow',
    unknown: 'allow',
  },
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PendingApproval {
  id: string
  sessionId: string
  toolName: string
  toolInput: unknown
  workspacePath: string
  resolve: (decision: 'allow' | 'deny') => void
  createdAt: Date
}

export type PendingApprovalInfo = Omit<PendingApproval, 'resolve'>

export type ApprovalScope = 'once' | 'session' | 'permanent'

export interface SettleResult {
  decision: 'allow' | 'deny'
  reason?: string
  source?: 'bypass' | 'mode' | 'rule' | 'protected' | 'user'
}

// ---------------------------------------------------------------------------
// ApprovalBridge
// ---------------------------------------------------------------------------

export class ApprovalBridge {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly policyStore: ApprovalPolicyStore | null
  private readonly settingsStore: SettingsStore | null
  private readonly categorize: (name: string, parseReason?: string, bashFsSubset?: boolean) => ToolCategory
  private readonly pendingAddedCallbacks = new Set<(info: PendingApprovalInfo) => void>()
  private readonly pendingSettledCallbacks = new Set<(id: string, result: SettleResult) => void>()

  constructor(
    policyStore?: ApprovalPolicyStore,
    settingsStore?: SettingsStore,
    categorize?: (name: string, parseReason?: string, bashFsSubset?: boolean) => ToolCategory,
  ) {
    this.policyStore = policyStore ?? null
    this.settingsStore = settingsStore ?? null
    this.categorize = categorize ?? categorizeClaudeCodeTool
  }

  onPendingAdded(callback: (info: PendingApprovalInfo) => void): () => void {
    this.pendingAddedCallbacks.add(callback)
    return () => {
      this.pendingAddedCallbacks.delete(callback)
    }
  }

  onPendingSettled(callback: (id: string, result: SettleResult) => void): () => void {
    this.pendingSettledCallbacks.add(callback)
    return () => {
      this.pendingSettledCallbacks.delete(callback)
    }
  }

  async addPending(
    approval: Omit<PendingApproval, 'resolve' | 'createdAt'>,
    meta?: { protectedHint?: string[]; parseReason?: string; bashFsSubset?: boolean },
  ): Promise<'allow' | 'deny'> {
    const mode = (
      this.settingsStore?.getEffectiveSettings(approval.workspacePath).permissionMode ?? 'default'
    ) as PermissionMode

    const category = this.categorize(approval.toolName, meta?.parseReason, meta?.bashFsSubset)
    const hasProtected = (meta?.protectedHint?.length ?? 0) > 0

    // Step 1: bypassPermissions — protected는 prompt, 나머지 allow
    if (mode === 'bypassPermissions') {
      if (hasProtected) {
        return this.enqueueForUser(approval)
      }
      return Promise.resolve('allow')
    }

    // Step 2: protected path는 모든 모드에서 prompt
    if (hasProtected) {
      return this.enqueueForUser(approval)
    }

    // Step 3: 모드 매트릭스 deny (plan의 edit 등 원천 차단)
    const matrixDecision = MODE_TOOL_MATRIX[mode]?.[category] ?? 'ask'
    if (matrixDecision === 'deny') {
      return Promise.resolve('deny')
    }

    // Step 4 & 5: policyStore 룰 매칭 (deny 우선, then allow)
    if (this.policyStore) {
      const ruleMatch = this.policyStore.matchRule(approval.toolName, approval.workspacePath, approval.sessionId)
      if (ruleMatch) {
        if (ruleMatch.decision === 'deny') {
          return Promise.resolve('deny')
        }
        // decision === 'allow'
        this.policyStore.logDecision({
          toolName: approval.toolName,
          toolUseId: approval.id,
          sessionId: approval.sessionId,
          workspacePath: approval.workspacePath,
          decision: 'allow',
          scope: ruleMatch.scope,
        })
        return Promise.resolve('allow')
      }
    }

    // Step 6: 모드 매트릭스 allow
    if (matrixDecision === 'allow') {
      return Promise.resolve('allow')
    }

    // Step 7: ask — pending 큐 진입
    return this.enqueueForUser(approval)
  }

  private enqueueForUser(
    approval: Omit<PendingApproval, 'resolve' | 'createdAt'>,
  ): Promise<'allow' | 'deny'> {
    return new Promise<'allow' | 'deny'>((resolve) => {
      const entry: PendingApproval = {
        ...approval,
        createdAt: new Date(),
        resolve,
      }
      this.pending.set(approval.id, entry)

      const { resolve: _resolve, ...info } = entry
      for (const cb of this.pendingAddedCallbacks) {
        cb(info)
      }

      const timer = setTimeout(() => {
        this._settle(approval.id, { decision: 'deny', source: 'user', reason: 'timeout' })
      }, APPROVAL_TIMEOUT_MS)
      this.timers.set(approval.id, timer)
    })
  }

  respond(toolUseId: string, decision: 'allow' | 'deny', scope?: ApprovalScope): boolean {
    const entry = this.pending.get(toolUseId)
    if (!entry) return false

    if (this.policyStore && decision === 'allow' && scope && scope !== 'once') {
      if (scope === 'session') {
        this.policyStore.addSessionRule(entry.toolName, entry.workspacePath)
      } else if (scope === 'permanent') {
        this.policyStore.addPermanentRule(entry.toolName, entry.workspacePath)
      }
    }

    if (this.policyStore) {
      this.policyStore.logDecision({
        toolName: entry.toolName,
        toolUseId,
        sessionId: entry.sessionId,
        workspacePath: entry.workspacePath,
        decision,
        scope: scope ?? 'once',
      })
    }

    this._settle(toolUseId, { decision, source: 'user' })
    return true
  }

  listPending(): PendingApprovalInfo[] {
    return Array.from(this.pending.values()).map(({ resolve: _resolve, ...rest }) => rest)
  }

  private _settle(id: string, result: SettleResult): void {
    const entry = this.pending.get(id)
    if (!entry) return

    const timer = this.timers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(id)
    }

    this.pending.delete(id)
    entry.resolve(result.decision)

    for (const cb of this.pendingSettledCallbacks) {
      cb(id, result)
    }
  }
}
