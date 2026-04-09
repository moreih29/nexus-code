import type { ApprovalPolicyStore } from '../db/approval-policy-store.js'
import type { SettingsStore } from '../db/settings-store.js'

const APPROVAL_TIMEOUT_MS = 300_000

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

export class ApprovalBridge {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly policyStore: ApprovalPolicyStore | null
  private readonly settingsStore: SettingsStore | null
  private readonly pendingAddedCallbacks = new Set<(info: PendingApprovalInfo) => void>()
  private readonly pendingSettledCallbacks = new Set<(id: string, decision: 'allow' | 'deny') => void>()

  constructor(policyStore?: ApprovalPolicyStore, settingsStore?: SettingsStore) {
    this.policyStore = policyStore ?? null
    this.settingsStore = settingsStore ?? null
  }

  onPendingAdded(callback: (info: PendingApprovalInfo) => void): () => void {
    this.pendingAddedCallbacks.add(callback)
    return () => {
      this.pendingAddedCallbacks.delete(callback)
    }
  }

  onPendingSettled(callback: (id: string, decision: 'allow' | 'deny') => void): () => void {
    this.pendingSettledCallbacks.add(callback)
    return () => {
      this.pendingSettledCallbacks.delete(callback)
    }
  }

  addPending(
    approval: Omit<PendingApproval, 'resolve' | 'createdAt'>,
    // T8: Bridge가 이 메타데이터를 소비하도록 수정 예정
    meta?: { protectedHint?: string[]; parseReason?: string },
  ): Promise<'allow' | 'deny'> {
    if (meta?.protectedHint && meta.protectedHint.length > 0) {
      // TODO(T8): 파이프라인 Step 0-7에서 처리
    }
    if (this.settingsStore) {
      const settings = this.settingsStore.getEffectiveSettings(approval.workspacePath)
      const mode = settings.permissionMode
      if (mode === 'bypassPermissions') {
        return Promise.resolve('allow')
      }
    }

    if (this.policyStore) {
      const match = this.policyStore.matchRule(approval.toolName, approval.workspacePath)
      if (match) {
        this.policyStore.logDecision({
          toolName: approval.toolName,
          toolUseId: approval.id,
          sessionId: approval.sessionId,
          workspacePath: approval.workspacePath,
          decision: 'allow',
          scope: match.scope,
        })
        return Promise.resolve('allow')
      }
    }

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
        this._settle(approval.id, 'deny')
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

    this._settle(toolUseId, decision)
    return true
  }

  listPending(): PendingApprovalInfo[] {
    return Array.from(this.pending.values()).map(({ resolve: _resolve, ...rest }) => rest)
  }

  private _settle(id: string, decision: 'allow' | 'deny'): void {
    const entry = this.pending.get(id)
    if (!entry) return

    const timer = this.timers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(id)
    }

    this.pending.delete(id)
    entry.resolve(decision)

    for (const cb of this.pendingSettledCallbacks) {
      cb(id, decision)
    }
  }
}
