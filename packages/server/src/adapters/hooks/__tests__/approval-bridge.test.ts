import { describe, it, expect, vi } from 'vitest'
import { ApprovalBridge } from '../approval-bridge.js'
import type { ApprovalPolicyStore, ApprovalRule } from '../../db/approval-policy-store.js'

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeSettingsStore(permissionMode?: string) {
  return {
    getEffectiveSettings: vi.fn().mockReturnValue(
      permissionMode !== undefined ? { permissionMode } : {},
    ),
  }
}

function makePendingApproval(overrides: Partial<{
  id: string
  sessionId: string
  toolName: string
  toolInput: unknown
  workspacePath: string
}> = {}) {
  return {
    id: overrides.id ?? 'tool-use-001',
    sessionId: overrides.sessionId ?? 'session-abc',
    toolName: overrides.toolName ?? 'Bash',
    toolInput: overrides.toolInput ?? { command: 'echo hello' },
    workspacePath: overrides.workspacePath ?? '/workspace/test',
  }
}

/**
 * Creates a minimal mock for ApprovalPolicyStore.
 * matchRule defaults to returning null (no rule match).
 */
function makePolicyStore(overrides: {
  matchRule?: ApprovalPolicyStore['matchRule']
  logDecision?: ApprovalPolicyStore['logDecision']
  addSessionRule?: ApprovalPolicyStore['addSessionRule']
  addPermanentRule?: ApprovalPolicyStore['addPermanentRule']
} = {}): ApprovalPolicyStore {
  return {
    matchRule: overrides.matchRule ?? vi.fn().mockReturnValue(null),
    logDecision: overrides.logDecision ?? vi.fn(),
    addSessionRule: overrides.addSessionRule ?? vi.fn(),
    addPermanentRule: overrides.addPermanentRule ?? vi.fn(),
    // Stub remaining methods that are not exercised by addPending
    addRule: vi.fn(),
    removePermanentRule: vi.fn(),
    listPermanentRules: vi.fn().mockReturnValue([]),
    deleteSessionRules: vi.fn().mockReturnValue(0),
    clearSessionRules: vi.fn(),
    getAuditLog: vi.fn().mockReturnValue([]),
    migrate: vi.fn(),
  } as unknown as ApprovalPolicyStore
}

function makeAllowRule(toolName = 'Bash'): ApprovalRule {
  return {
    id: 'rule-001',
    toolName,
    scope: 'permanent',
    workspacePath: null,
    decision: 'allow',
    sessionId: null,
    createdAt: new Date().toISOString(),
  }
}

function makeDenyRule(toolName = 'Bash'): ApprovalRule {
  return {
    id: 'rule-002',
    toolName,
    scope: 'permanent',
    workspacePath: null,
    decision: 'deny',
    sessionId: null,
    createdAt: new Date().toISOString(),
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Scenario 3b: bypassPermissions mode → immediate allow (EXISTING — keep)
// ────────────────────────────────────────────────────────────────────────────
describe('ApprovalBridge — permission mode: bypassPermissions', () => {
  it('resolves immediately with "allow" without adding to pending', async () => {
    const settingsStore = makeSettingsStore('bypassPermissions')
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval()

    const decision = await bridge.addPending(approval)

    expect(decision).toBe('allow')
    expect(bridge.listPending()).toHaveLength(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Scenario 3c: default mode (no permissionMode / "default") → pending queue
// ────────────────────────────────────────────────────────────────────────────
describe('ApprovalBridge — permission mode: default', () => {
  it('adds the approval to pending when no settingsStore is provided', () => {
    const bridge = new ApprovalBridge()
    const approval = makePendingApproval()

    void bridge.addPending(approval)

    const pending = bridge.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.id).toBe(approval.id)
    expect(pending[0]!.toolName).toBe(approval.toolName)
  })

  it('adds the approval to pending when permissionMode is undefined', () => {
    const settingsStore = makeSettingsStore(undefined)
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval()

    void bridge.addPending(approval)

    expect(bridge.listPending()).toHaveLength(1)
  })

  it('resolves with the decision made via respond()', async () => {
    const bridge = new ApprovalBridge()
    const approval = makePendingApproval()

    const promise = bridge.addPending(approval)

    const responded = bridge.respond(approval.id, 'allow')
    expect(responded).toBe(true)

    expect(await promise).toBe('allow')
    expect(bridge.listPending()).toHaveLength(0)
  })

  it('resolves with deny when responded with deny', async () => {
    const bridge = new ApprovalBridge()
    const approval = makePendingApproval()

    const promise = bridge.addPending(approval)
    bridge.respond(approval.id, 'deny')

    expect(await promise).toBe('deny')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Scenario 3d: no short-circuit for permissionMode "default" (explicit value)
// ────────────────────────────────────────────────────────────────────────────
describe('ApprovalBridge — permission mode: explicit "default" string', () => {
  it('adds approval to pending when permissionMode is "default"', () => {
    const settingsStore = makeSettingsStore('default')
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval()

    void bridge.addPending(approval)

    expect(bridge.listPending()).toHaveLength(1)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// NEW: Mode × Tool matrix — default mode (4 scenarios)
// ────────────────────────────────────────────────────────────────────────────
describe('ApprovalBridge — mode×tool matrix: default mode', () => {
  it('scenario 1 — Read tool → allow (source: mode, no pending)', async () => {
    const settingsStore = makeSettingsStore('default')
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval({ toolName: 'Read', toolInput: { file_path: '/workspace/test/foo.ts' } })

    const decision = await bridge.addPending(approval)

    expect(decision).toBe('allow')
    expect(bridge.listPending()).toHaveLength(0)
  })

  it('scenario 2 — Edit tool → pending queue (ask)', () => {
    const settingsStore = makeSettingsStore('default')
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval({ toolName: 'Edit', toolInput: { file_path: '/workspace/test/foo.ts', old_string: 'a', new_string: 'b' } })

    void bridge.addPending(approval)

    const pending = bridge.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.toolName).toBe('Edit')
  })

  it('scenario 3 — Bash tool → pending queue (ask), regardless of meta absence', () => {
    const settingsStore = makeSettingsStore('default')
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval({ toolName: 'Bash', toolInput: { command: 'ls -la' } })

    void bridge.addPending(approval)

    const pending = bridge.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.toolName).toBe('Bash')
  })

  it('scenario 4 — Task tool → allow (source: mode, no pending)', async () => {
    const settingsStore = makeSettingsStore('default')
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval({ toolName: 'Task', toolInput: { description: 'Do something' } })

    const decision = await bridge.addPending(approval)

    expect(decision).toBe('allow')
    expect(bridge.listPending()).toHaveLength(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// NEW: Mode × Tool matrix — acceptEdits mode (4 scenarios)
// ────────────────────────────────────────────────────────────────────────────
describe('ApprovalBridge — mode×tool matrix: acceptEdits mode', () => {
  it('scenario 5 — Edit tool → allow (source: mode)', async () => {
    const settingsStore = makeSettingsStore('acceptEdits')
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval({ toolName: 'Edit', toolInput: { file_path: '/workspace/test/foo.ts', old_string: 'a', new_string: 'b' } })

    const decision = await bridge.addPending(approval)

    expect(decision).toBe('allow')
    expect(bridge.listPending()).toHaveLength(0)
  })

  it('scenario 6 — Bash + bashFsSubset=true + no protected → allow (bash-fs category)', async () => {
    const settingsStore = makeSettingsStore('acceptEdits')
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval({ toolName: 'Bash', toolInput: { command: 'cat /workspace/test/foo.ts' } })

    const decision = await bridge.addPending(approval, { bashFsSubset: true })

    expect(decision).toBe('allow')
    expect(bridge.listPending()).toHaveLength(0)
  })

  it('scenario 7 — Bash + bashFsSubset=false + parseReason → pending queue (bash-other)', () => {
    const settingsStore = makeSettingsStore('acceptEdits')
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval({ toolName: 'Bash', toolInput: { command: 'curl http://example.com' } })

    void bridge.addPending(approval, { parseReason: 'unsupported-command' })

    const pending = bridge.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.toolName).toBe('Bash')
  })

  it('scenario 8 — WebFetch → pending queue (ask)', () => {
    const settingsStore = makeSettingsStore('acceptEdits')
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval({ toolName: 'WebFetch', toolInput: { url: 'https://example.com' } })

    void bridge.addPending(approval)

    const pending = bridge.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.toolName).toBe('WebFetch')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// NEW: Mode × Tool matrix — plan mode (3 scenarios)
// ────────────────────────────────────────────────────────────────────────────
describe('ApprovalBridge — mode×tool matrix: plan mode', () => {
  it('scenario 9 — Edit tool → deny (plan mode blocks edits)', async () => {
    const settingsStore = makeSettingsStore('plan')
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval({ toolName: 'Edit', toolInput: { file_path: '/workspace/test/foo.ts', old_string: 'a', new_string: 'b' } })

    const decision = await bridge.addPending(approval)

    expect(decision).toBe('deny')
    expect(bridge.listPending()).toHaveLength(0)
  })

  it('scenario 10 — Read tool → allow (plan mode permits reading)', async () => {
    const settingsStore = makeSettingsStore('plan')
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval({ toolName: 'Read', toolInput: { file_path: '/workspace/test/foo.ts' } })

    const decision = await bridge.addPending(approval)

    expect(decision).toBe('allow')
    expect(bridge.listPending()).toHaveLength(0)
  })

  it('scenario 11 — Bash tool → pending queue (ask, plan does not auto-deny bash)', () => {
    const settingsStore = makeSettingsStore('plan')
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval({ toolName: 'Bash', toolInput: { command: 'echo hello' } })

    void bridge.addPending(approval)

    const pending = bridge.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.toolName).toBe('Bash')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// NEW: Mode × Tool matrix — bypassPermissions mode (3 scenarios)
// ────────────────────────────────────────────────────────────────────────────
describe('ApprovalBridge — mode×tool matrix: bypassPermissions mode', () => {
  it('scenario 12 — Edit tool → allow (bypass skips all checks)', async () => {
    const settingsStore = makeSettingsStore('bypassPermissions')
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval({ toolName: 'Edit', toolInput: { file_path: '/workspace/test/foo.ts', old_string: 'a', new_string: 'b' } })

    const decision = await bridge.addPending(approval)

    expect(decision).toBe('allow')
    expect(bridge.listPending()).toHaveLength(0)
  })

  it('scenario 13 — Bash tool → allow (bypass skips all checks)', async () => {
    const settingsStore = makeSettingsStore('bypassPermissions')
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval({ toolName: 'Bash', toolInput: { command: 'rm -rf /tmp/test' } })

    const decision = await bridge.addPending(approval)

    expect(decision).toBe('allow')
    expect(bridge.listPending()).toHaveLength(0)
  })

  it('scenario 14 — mcp__foo tool → allow (bypass skips all checks)', async () => {
    const settingsStore = makeSettingsStore('bypassPermissions')
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval({ toolName: 'mcp__foo', toolInput: { args: [] } })

    const decision = await bridge.addPending(approval)

    expect(decision).toBe('allow')
    expect(bridge.listPending()).toHaveLength(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// NEW: Pipeline order (4 scenarios)
// ────────────────────────────────────────────────────────────────────────────
describe('ApprovalBridge — pipeline order', () => {
  it('scenario 15 — protected > bypass: bypass mode + protectedHint → pending queue (not immediate allow)', () => {
    const settingsStore = makeSettingsStore('bypassPermissions')
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval({ toolName: 'Edit', toolInput: { file_path: '/workspace/test/foo.ts', old_string: 'a', new_string: 'b' } })

    void bridge.addPending(approval, { protectedHint: ['.env'] })

    // Protected path forces the prompt even in bypass mode (Step 1 check)
    const pending = bridge.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.toolName).toBe('Edit')
  })

  it('scenario 16 — mode deny > rule allow: plan mode + Edit + allow rule in policyStore → deny (mode wins)', async () => {
    // plan mode denies Edit at Step 3 (matrix deny), policyStore allow rule at Step 4 is never reached
    const settingsStore = makeSettingsStore('plan')
    const policyStore = makePolicyStore({
      matchRule: vi.fn().mockReturnValue(makeAllowRule('Edit')),
    })
    const bridge = new ApprovalBridge(policyStore, settingsStore as never)
    const approval = makePendingApproval({ toolName: 'Edit', toolInput: { file_path: '/workspace/test/foo.ts', old_string: 'a', new_string: 'b' } })

    const decision = await bridge.addPending(approval)

    // Matrix deny (Step 3) must fire before policyStore (Step 4)
    expect(decision).toBe('deny')
    expect(bridge.listPending()).toHaveLength(0)
  })

  it('scenario 17 — rule deny > rule allow: default mode + Bash + deny rule → deny', async () => {
    // policyStore returns a deny rule → Step 4 fires deny before reaching Step 6/7
    const settingsStore = makeSettingsStore('default')
    const policyStore = makePolicyStore({
      matchRule: vi.fn().mockReturnValue(makeDenyRule('Bash')),
    })
    const bridge = new ApprovalBridge(policyStore, settingsStore as never)
    const approval = makePendingApproval({ toolName: 'Bash', toolInput: { command: 'ls' } })

    const decision = await bridge.addPending(approval)

    expect(decision).toBe('deny')
    expect(bridge.listPending()).toHaveLength(0)
  })

  it('scenario 18 — bypass skips policyStore: bypass mode + deny rule in policyStore → allow', async () => {
    // bypassPermissions resolves at Step 1 and never consults policyStore
    const settingsStore = makeSettingsStore('bypassPermissions')
    const matchRule = vi.fn().mockReturnValue(makeDenyRule('Bash'))
    const policyStore = makePolicyStore({ matchRule })
    const bridge = new ApprovalBridge(policyStore, settingsStore as never)
    const approval = makePendingApproval({ toolName: 'Bash', toolInput: { command: 'rm -rf /tmp' } })

    const decision = await bridge.addPending(approval)

    expect(decision).toBe('allow')
    // policyStore must NOT be consulted in bypass mode
    expect(matchRule).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// NEW: Return type / fallback (2 scenarios)
// ────────────────────────────────────────────────────────────────────────────
describe('ApprovalBridge — return type and mode fallback', () => {
  it('scenario 19 — settingsStore undefined → default mode fallback, Read allows', async () => {
    // No settingsStore → mode defaults to "default" → Read is allowed by matrix
    const bridge = new ApprovalBridge()
    const approval = makePendingApproval({ toolName: 'Read', toolInput: { file_path: '/workspace/test/foo.ts' } })

    const decision = await bridge.addPending(approval)

    expect(decision).toBe('allow')
    expect(bridge.listPending()).toHaveLength(0)
  })

  it('scenario 20 — permissionMode undefined → "default" string fallback, Edit goes to pending', () => {
    // settingsStore returns no permissionMode → falls back to "default"
    const settingsStore = makeSettingsStore(undefined)
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval({ toolName: 'Edit', toolInput: { file_path: '/workspace/test/foo.ts', old_string: 'a', new_string: 'b' } })

    void bridge.addPending(approval)

    const pending = bridge.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.toolName).toBe('Edit')
  })
})
