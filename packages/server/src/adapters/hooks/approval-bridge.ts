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

export class ApprovalBridge {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  addPending(
    approval: Omit<PendingApproval, 'resolve' | 'createdAt'>,
  ): Promise<'allow' | 'deny'> {
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

  respond(toolUseId: string, decision: 'allow' | 'deny'): boolean {
    if (!this.pending.has(toolUseId)) return false
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
