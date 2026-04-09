import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { ApprovalPolicyStore } from '../approval-policy-store.js'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  return db
}

const WS_A = '/home/user/workspace-a'
const WS_B = '/home/user/workspace-b'
const SESSION_1 = 'session-abc-001'
const SESSION_2 = 'session-xyz-002'

describe('ApprovalPolicyStore', () => {
  let db: Database.Database
  let store: ApprovalPolicyStore

  beforeEach(() => {
    db = makeDb()
    store = new ApprovalPolicyStore(db)
  })

  // =========================================================================
  // deny rule 매칭 (4개)
  // =========================================================================

  describe('deny rule 매칭', () => {
    it('1. deny rule 단독 — matchRule이 decision:deny 반환', () => {
      store.addRule({ toolName: 'Bash', scope: 'permanent', workspacePath: null, decision: 'deny' })

      const result = store.matchRule('Bash', null)

      expect(result).not.toBeNull()
      expect(result!.decision).toBe('deny')
    })

    it('2. deny rule 없으면 allow rule 반환', () => {
      store.addRule({ toolName: 'Edit', scope: 'permanent', workspacePath: null, decision: 'allow' })

      const result = store.matchRule('Edit', null)

      expect(result).not.toBeNull()
      expect(result!.decision).toBe('allow')
    })

    it('3. allow + deny 동일 specificity 동시 존재 시 deny 우선', () => {
      // 동일 workspace + 동일 toolName → ORDER BY deny 우선 (3번째 sort key)
      store.addRule({ toolName: 'Write', scope: 'permanent', workspacePath: WS_A, decision: 'allow' })
      store.addRule({ toolName: 'Write', scope: 'permanent', workspacePath: WS_A, decision: 'deny' })

      const result = store.matchRule('Write', WS_A)

      expect(result).not.toBeNull()
      expect(result!.decision).toBe('deny')
    })

    it('4. workspace-specific deny가 global allow를 override', () => {
      // global allow
      store.addRule({ toolName: 'Edit', scope: 'permanent', workspacePath: null, decision: 'allow' })
      // workspace-specific deny
      store.addRule({ toolName: 'Edit', scope: 'permanent', workspacePath: WS_A, decision: 'deny' })

      const result = store.matchRule('Edit', WS_A)

      expect(result).not.toBeNull()
      expect(result!.decision).toBe('deny')
      expect(result!.workspacePath).toBe(WS_A)
    })
  })

  // =========================================================================
  // specificity 10+ (10개)
  // =========================================================================

  describe('specificity', () => {
    it('5. workspace-specific > global: workspace-A allow + global deny → allow 선택', () => {
      store.addRule({ toolName: 'Edit', scope: 'permanent', workspacePath: WS_A, decision: 'allow' })
      store.addRule({ toolName: 'Edit', scope: 'permanent', workspacePath: null, decision: 'deny' })

      const result = store.matchRule('Edit', WS_A)

      expect(result).not.toBeNull()
      expect(result!.decision).toBe('allow')
      expect(result!.workspacePath).toBe(WS_A)
    })

    it('6. specific-tool > wildcard: Edit allow + * deny → Edit allow', () => {
      store.addRule({ toolName: 'Edit', scope: 'permanent', workspacePath: null, decision: 'allow' })
      store.addRule({ toolName: '*', scope: 'permanent', workspacePath: null, decision: 'deny' })

      const result = store.matchRule('Edit', null)

      expect(result).not.toBeNull()
      expect(result!.decision).toBe('allow')
      expect(result!.toolName).toBe('Edit')
    })

    it('7. deny > allow (동일 workspace + 동일 tool specificity)', () => {
      store.addRule({ toolName: 'Bash', scope: 'permanent', workspacePath: WS_A, decision: 'allow' })
      store.addRule({ toolName: 'Bash', scope: 'permanent', workspacePath: WS_A, decision: 'deny' })

      const result = store.matchRule('Bash', WS_A)

      expect(result!.decision).toBe('deny')
    })

    it('8. Edit specific+workspace-A allow vs * global deny → Edit allow (specific 우선)', () => {
      // sort key Rule A: (workspace=1, tool=1, deny=2) → wins
      // sort key Rule B: (workspace=2, tool=2, deny=1)
      store.addRule({ toolName: 'Edit', scope: 'permanent', workspacePath: WS_A, decision: 'allow' })
      store.addRule({ toolName: '*', scope: 'permanent', workspacePath: null, decision: 'deny' })

      const result = store.matchRule('Edit', WS_A)

      expect(result!.decision).toBe('allow')
      expect(result!.toolName).toBe('Edit')
    })

    it('9. workspace-A * deny + global Edit allow → deny (workspace 우선)', () => {
      // sort key Rule A: (workspace=1, tool=2, deny=1) → wins over (workspace=2, tool=1, deny=2)
      store.addRule({ toolName: '*', scope: 'permanent', workspacePath: WS_A, decision: 'deny' })
      store.addRule({ toolName: 'Edit', scope: 'permanent', workspacePath: null, decision: 'allow' })

      const result = store.matchRule('Edit', WS_A)

      expect(result!.decision).toBe('deny')
      expect(result!.workspacePath).toBe(WS_A)
    })

    it('10. global only: specific-tool > wildcard — Edit allow + * deny (둘 다 global) → Edit allow', () => {
      store.addRule({ toolName: 'Edit', scope: 'permanent', workspacePath: null, decision: 'allow' })
      store.addRule({ toolName: '*', scope: 'permanent', workspacePath: null, decision: 'deny' })

      const result = store.matchRule('Edit', null)

      expect(result!.decision).toBe('allow')
      expect(result!.toolName).toBe('Edit')
    })

    it('11. sessionId 전달 시 session rule이 매칭됨 (session_id=sessionId OR NULL 모두 포함)', () => {
      // permanent rule (session_id=NULL)
      store.addRule({ toolName: 'Bash', scope: 'permanent', workspacePath: null, decision: 'allow' })
      // session rule (session_id=SESSION_1)
      store.addRule({ toolName: 'Bash', scope: 'session', workspacePath: WS_A, decision: 'deny', sessionId: SESSION_1 })

      const result = store.matchRule('Bash', WS_A, SESSION_1)

      // session rule은 workspace-specific + sessionId 매칭 → 매칭됨을 확인
      expect(result).not.toBeNull()
      // workspace-specific rule이 global rule보다 우선: session deny rule이 반환됨
      expect(result!.decision).toBe('deny')
      expect(result!.sessionId).toBe(SESSION_1)
    })

    it('12. 모든 조건 NULL(global + wildcard) → 기본 매칭 반환', () => {
      store.addRule({ toolName: '*', scope: 'permanent', workspacePath: null, decision: 'allow' })

      const result = store.matchRule('AnyTool', null)

      expect(result).not.toBeNull()
      expect(result!.toolName).toBe('*')
      expect(result!.decision).toBe('allow')
    })

    it('13. 다른 workspace의 rule은 매칭 안 됨 (workspace isolation)', () => {
      // WS_B에만 rule 존재
      store.addRule({ toolName: 'Edit', scope: 'permanent', workspacePath: WS_B, decision: 'allow' })

      // WS_A로 조회 → 매칭 없음
      const result = store.matchRule('Edit', WS_A)

      expect(result).toBeNull()
    })

    it('14. 여러 allow rule 동시 존재 시 가장 specific한 것 선택', () => {
      // global wildcard (가장 낮은 specificity)
      store.addRule({ toolName: '*', scope: 'permanent', workspacePath: null, decision: 'allow' })
      // global specific
      store.addRule({ toolName: 'Edit', scope: 'permanent', workspacePath: null, decision: 'allow' })
      // workspace-specific
      store.addRule({ toolName: 'Edit', scope: 'permanent', workspacePath: WS_A, decision: 'allow' })

      const result = store.matchRule('Edit', WS_A)

      // 가장 specific: workspace=WS_A + tool='Edit'
      expect(result!.workspacePath).toBe(WS_A)
      expect(result!.toolName).toBe('Edit')
    })
  })

  // =========================================================================
  // 세션 rule DB 복원 (3개)
  // =========================================================================

  describe('세션 rule DB 복원', () => {
    it('15. addRule({scope:session, sessionId, ...}) → DB에 session_id 컬럼 세팅', () => {
      const rule = store.addRule({
        toolName: 'Bash',
        scope: 'session',
        workspacePath: WS_A,
        decision: 'allow',
        sessionId: SESSION_1,
      })

      expect(rule.scope).toBe('session')
      expect(rule.sessionId).toBe(SESSION_1)
      expect(rule.toolName).toBe('Bash')
      expect(rule.workspacePath).toBe(WS_A)
    })

    it('16. 재시작(store 재생성) 후 matchRule로 세션 rule 조회 가능', () => {
      // 동일 DB 인스턴스로 store 재생성 — DB 영속성 시뮬레이션
      store.addRule({
        toolName: 'Edit',
        scope: 'session',
        workspacePath: WS_A,
        decision: 'allow',
        sessionId: SESSION_1,
      })

      // store 재생성 (같은 db 인스턴스 재사용 — DB 파일 영속성 대리)
      const store2 = new ApprovalPolicyStore(db)

      const result = store2.matchRule('Edit', WS_A, SESSION_1)

      expect(result).not.toBeNull()
      expect(result!.sessionId).toBe(SESSION_1)
      expect(result!.decision).toBe('allow')
    })

    it('17. deleteSessionRules(sessionId) → 해당 session만 삭제, 다른 session 유지', () => {
      store.addRule({ toolName: 'Bash', scope: 'session', workspacePath: WS_A, decision: 'allow', sessionId: SESSION_1 })
      store.addRule({ toolName: 'Edit', scope: 'session', workspacePath: WS_B, decision: 'allow', sessionId: SESSION_2 })

      const deleted = store.deleteSessionRules(SESSION_1)

      expect(deleted).toBe(1)

      // SESSION_1 rule은 삭제됨
      const result1 = store.matchRule('Bash', WS_A, SESSION_1)
      expect(result1).toBeNull()

      // SESSION_2 rule은 유지됨
      const result2 = store.matchRule('Edit', WS_B, SESSION_2)
      expect(result2).not.toBeNull()
      expect(result2!.sessionId).toBe(SESSION_2)
    })
  })

  // =========================================================================
  // Layer 2 가드 (보너스)
  // =========================================================================

  describe('Layer 2 가드', () => {
    it('18. PROTECTED_DIRS(.git) 경로에 rule 추가 시 throw', () => {
      expect(() =>
        store.addRule({
          toolName: 'Write',
          scope: 'permanent',
          workspacePath: '/workspace/.git',
          decision: 'allow',
        }),
      ).toThrow(/protected/i)
    })

    it('18b. PROTECTED_DIRS(.husky) 경로에 rule 추가 시 throw', () => {
      expect(() =>
        store.addRule({
          toolName: 'Bash',
          scope: 'permanent',
          workspacePath: '/workspace/.husky',
          decision: 'deny',
        }),
      ).toThrow(/protected/i)
    })

    it('18c. PROTECTED_DIRS(.nexus/state) 경로에 rule 추가 시 throw', () => {
      expect(() =>
        store.addRule({
          toolName: 'Edit',
          scope: 'permanent',
          workspacePath: '/workspace/.nexus/state',
          decision: 'allow',
        }),
      ).toThrow(/protected/i)
    })
  })

  // =========================================================================
  // 하위 호환 (deprecated wrappers)
  // =========================================================================

  describe('deprecated wrappers 하위 호환', () => {
    it('addPermanentRule → scope=permanent, decision=allow 기본값', () => {
      const rule = store.addPermanentRule('Edit', WS_A)

      expect(rule.scope).toBe('permanent')
      expect(rule.decision).toBe('allow')
      expect(rule.workspacePath).toBe(WS_A)
    })

    it('addSessionRule → addRule session scope로 위임', () => {
      store.addSessionRule('Bash', WS_A, SESSION_1)

      const result = store.matchRule('Bash', WS_A, SESSION_1)

      expect(result).not.toBeNull()
      expect(result!.scope).toBe('session')
    })

    it('clearSessionRules → no-op (세션 rule은 DB에 유지)', () => {
      store.addRule({ toolName: 'Edit', scope: 'session', workspacePath: WS_A, decision: 'allow', sessionId: SESSION_1 })

      store.clearSessionRules()

      // no-op이므로 rule 유지됨
      const result = store.matchRule('Edit', WS_A, SESSION_1)
      expect(result).not.toBeNull()
    })
  })

  // =========================================================================
  // migrate 멱등성
  // =========================================================================

  describe('migrate 멱등성', () => {
    it('migrate 두 번 호출해도 오류 없음 (IF NOT EXISTS + column idempotency)', () => {
      expect(() => store.migrate()).not.toThrow()
    })
  })
})
