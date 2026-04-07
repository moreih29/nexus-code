import type { ApprovalPolicyStore } from '../db/approval-policy-store.js'

const APPROVAL_TIMEOUT_MS = 60_000

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

  constructor(policyStore?: ApprovalPolicyStore) {
    this.policyStore = policyStore ?? null
  }

  addPending(
    approval: Omit<PendingApproval, 'resolve' | 'createdAt'>,
  ): Promise<'allow' | 'deny'> {
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
  }
}
