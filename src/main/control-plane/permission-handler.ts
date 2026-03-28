import type { ApprovalRule, ApprovalScope } from '../../shared/types'

const TIMEOUT_MS = 60_000

// 읽기 전용으로 자동 승인할 Bash 명령어 패턴
const AUTO_APPROVE_BASH_PATTERNS: RegExp[] = [
  /^\s*cat\b/,
  /^\s*grep\b/,
  /^\s*rg\b/,
  /^\s*ls\b/,
  /^\s*ll\b/,
  /^\s*find\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*wc\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*pwd\b/,
  /^\s*which\b/,
  /^\s*type\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|fetch|tag|describe|rev-parse|shortlog|stash\s+list)\b/,
  /^\s*git\s+--no-pager\s+(status|log|diff|show)\b/,
]

// 자동 승인할 도구 이름
const AUTO_APPROVE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS'])

interface PendingRequest {
  resolve: (result: { approved: boolean; scope?: ApprovalScope }) => void
  timer: ReturnType<typeof setTimeout>
}

export class PermissionHandler {
  private pending = new Map<string, PendingRequest>()
  private sessionRules: ApprovalRule[] = []
  private permanentRules: ApprovalRule[] = []

  /** 앱 시작 시 영구 룰을 주입한다 (approval-store에서 로드 후 호출) */
  setPermanentRules(rules: ApprovalRule[]): void {
    this.permanentRules = rules
  }

  addSessionRule(toolName: string): void {
    if (!this.sessionRules.some((r) => r.toolName === toolName)) {
      this.sessionRules.push({ toolName, scope: 'session' })
    }
  }

  addPermanentRule(toolName: string): void {
    if (!this.permanentRules.some((r) => r.toolName === toolName)) {
      this.permanentRules.push({ toolName, scope: 'permanent' })
    }
  }

  clearSessionRules(): void {
    this.sessionRules = []
  }

  /**
   * 도구 호출이 자동 승인 대상인지 판단한다.
   * - 읽기 전용 도구 목록에 있으면 true
   * - Bash 도구이면서 화이트리스트 명령어이면 true
   * - session/permanent 룰에 포함되어 있으면 true
   * - 그 외 모두 false (수동 승인 필요)
   */
  isAutoApproved(toolName: string, input: Record<string, unknown>): boolean {
    if (AUTO_APPROVE_TOOLS.has(toolName)) return true

    if (toolName === 'Bash') {
      const command = typeof input['command'] === 'string' ? input['command'] : ''
      if (AUTO_APPROVE_BASH_PATTERNS.some((re) => re.test(command))) return true
    }

    if (this.sessionRules.some((r) => r.toolName === toolName)) return true
    if (this.permanentRules.some((r) => r.toolName === toolName)) return true

    return false
  }

  /**
   * requestId에 대한 Renderer 응답을 기다린다.
   * 60초 내에 응답이 없으면 deny를 반환한다.
   */
  waitForResponse(requestId: string): Promise<{ approved: boolean; scope?: ApprovalScope }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({ approved: false })
      }, TIMEOUT_MS)

      this.pending.set(requestId, { resolve, timer })
    })
  }

  /**
   * Renderer에서 RESPOND_PERMISSION IPC를 수신했을 때 호출한다.
   */
  respond(requestId: string, approved: boolean, scope?: ApprovalScope): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) return false

    clearTimeout(entry.timer)
    this.pending.delete(requestId)
    entry.resolve({ approved, scope })
    return true
  }

  /** 서버 종료 시 대기 중인 모든 요청을 deny 처리 */
  rejectAll(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve({ approved: false })
      this.pending.delete(id)
    }
  }
}
