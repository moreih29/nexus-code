import { describe, it, expect, vi } from 'vitest'
import { ApprovalBridge } from '../approval-bridge.js'

// Minimal mock for SettingsStore — only getEffectiveSettings is exercised by ApprovalBridge
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

// ────────────────────────────────────────────────────────────────────────────
// Scenario 3a: auto mode → immediate allow
// ────────────────────────────────────────────────────────────────────────────
describe('ApprovalBridge — permission mode: auto', () => {
  it('resolves immediately with "allow" without adding to pending', async () => {
    const settingsStore = makeSettingsStore('auto')
    const bridge = new ApprovalBridge(undefined, settingsStore as never)
    const approval = makePendingApproval()

    const decision = await bridge.addPending(approval)

    expect(decision).toBe('allow')
    // Nothing should be pending — the request was short-circuited
    expect(bridge.listPending()).toHaveLength(0)
  })

  it('does not wait for a respond() call — resolves synchronously', async () => {
    const settingsStore = makeSettingsStore('auto')
    const bridge = new ApprovalBridge(undefined, settingsStore as never)

    let resolved = false
    const promise = bridge.addPending(makePendingApproval()).then((d) => {
      resolved = true
      return d
    })

    // The promise should already be resolved in the microtask queue
    await Promise.resolve()
    expect(resolved).toBe(true)
    expect(await promise).toBe('allow')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Scenario 3b: bypassPermissions mode → immediate allow
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
    // No settings store — falls through to the pending queue
    const bridge = new ApprovalBridge()
    const approval = makePendingApproval()

    // Do NOT await — we want to inspect the in-flight state
    void bridge.addPending(approval)

    const pending = bridge.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.id).toBe(approval.id)
    expect(pending[0]!.toolName).toBe(approval.toolName)
  })

  it('adds the approval to pending when permissionMode is undefined', () => {
    // Settings store exists but returns no permissionMode
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

    // Respond while the promise is in-flight
    const responded = bridge.respond(approval.id, 'allow')
    expect(responded).toBe(true)

    expect(await promise).toBe('allow')
    // Pending is cleared after settlement
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
