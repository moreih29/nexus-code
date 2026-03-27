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
  resolve: (approved: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

export class PermissionHandler {
  private pending = new Map<string, PendingRequest>()

  /**
   * 도구 호출이 자동 승인 대상인지 판단한다.
   * - 읽기 전용 도구 목록에 있으면 true
   * - Bash 도구이면서 화이트리스트 명령어이면 true
   * - 그 외 모두 false (수동 승인 필요)
   */
  isAutoApproved(toolName: string, input: Record<string, unknown>): boolean {
    if (AUTO_APPROVE_TOOLS.has(toolName)) return true

    if (toolName === 'Bash') {
      const command = typeof input['command'] === 'string' ? input['command'] : ''
      return AUTO_APPROVE_BASH_PATTERNS.some((re) => re.test(command))
    }

    return false
  }

  /**
   * requestId에 대한 Renderer 응답을 기다린다.
   * 60초 내에 응답이 없으면 false(deny)를 반환한다.
   */
  waitForResponse(requestId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve(false) // 타임아웃 → deny
      }, TIMEOUT_MS)

      this.pending.set(requestId, { resolve, timer })
    })
  }

  /**
   * Renderer에서 RESPOND_PERMISSION IPC를 수신했을 때 호출한다.
   * 대기 중인 요청이 없으면 no-op.
   */
  respond(requestId: string, approved: boolean): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) return false

    clearTimeout(entry.timer)
    this.pending.delete(requestId)
    entry.resolve(approved)
    return true
  }

  /** 서버 종료 시 대기 중인 모든 요청을 deny 처리 */
  rejectAll(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve(false)
      this.pending.delete(id)
    }
  }
}
