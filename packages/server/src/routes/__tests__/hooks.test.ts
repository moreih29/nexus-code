import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHooksRouter } from '../hooks.js'
import { ApprovalBridge } from '../../adapters/hooks/approval-bridge.js'
import type { PendingApprovalInfo } from '../../adapters/hooks/approval-bridge.js'
import { HookManager } from '../../adapters/hooks/hook-manager.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal SettingsStore mock — only getEffectiveSettings is consumed by ApprovalBridge */
function makeSettingsStore(permissionMode?: string) {
  return {
    getEffectiveSettings: vi.fn().mockReturnValue(
      permissionMode !== undefined ? { permissionMode } : {},
    ),
  }
}

/**
 * Build a minimal Hono app with the hooks router mounted at /hooks.
 *
 * Returns the app, the approvalBridge (for calling respond()), and the valid
 * token needed to pass the auth check in hooks.ts.
 */
function makeApp(permissionMode?: string) {
  const hookManager = new HookManager(3099)
  // Access the private token via type cast — tests only, never in production code
  const token = (hookManager as unknown as Record<string, string>)['hookToken']

  const settingsStore = makeSettingsStore(permissionMode)
  const bridge = new ApprovalBridge(undefined, settingsStore as never)

  const router = createHooksRouter(hookManager, bridge)
  const app = new Hono()
  app.route('/hooks', router)

  return { app, bridge, token }
}

/** POST /hooks/pre-tool-use with the given body and optional query token. */
async function postPreToolUse(
  app: Hono,
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(`/hooks/pre-tool-use?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * Wait until the approval bridge has at least one pending entry.
 *
 * Uses the bridge's onPendingAdded callback so the test is not racing
 * against real fs.realpath calls inside preflightPaths.
 *
 * Returns the first PendingApprovalInfo added, or times out after `ms`.
 */
function waitForPending(bridge: ApprovalBridge, ms = 2000): Promise<PendingApprovalInfo> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`waitForPending timed out after ${ms}ms — no pending entry arrived`))
    }, ms)

    const unsubscribe = bridge.onPendingAdded((info) => {
      clearTimeout(timer)
      unsubscribe()
      resolve(info)
    })
  })
}

// ---------------------------------------------------------------------------
// Scenario 1: Normal Edit round-trip — default mode, user responds "allow"
// ---------------------------------------------------------------------------

describe('POST /hooks/pre-tool-use — Scenario 1: normal Edit round-trip (default mode)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'))
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  })

  it('returns allow decision after respond() is called with "allow" in default mode', async () => {
    const { app, bridge, token } = makeApp('default')

    const toolUseId = 'test-1-allow'
    const requestBody = {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'foo.ts') },
      tool_use_id: toolUseId,
      session_id: 'session-default-001',
      hook_event_name: 'PreToolUse',
      cwd: tmpDir,
    }

    // Fire the POST — it will block waiting for user approval
    const responsePromise = postPreToolUse(app, token, requestBody)

    // Wait until preflightPaths + addPending have enqueued the entry
    const pendingInfo = await waitForPending(bridge)

    // Confirm the pending entry is correct
    expect(pendingInfo.id).toBe(toolUseId)
    expect(pendingInfo.toolName).toBe('Edit')
    expect(bridge.listPending()).toHaveLength(1)

    // Simulate user approval
    bridge.respond(toolUseId, 'allow')

    const res = await responsePromise
    expect(res.status).toBe(200)

    const body = await res.json() as {
      hookSpecificOutput: {
        hookEventName: string
        permissionDecision: string
        permissionDecisionReason: string
      }
    }

    expect(body.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(body.hookSpecificOutput.permissionDecision).toBe('allow')
    expect(typeof body.hookSpecificOutput.permissionDecisionReason).toBe('string')
    expect(body.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0)

    // Queue cleared after settlement
    expect(bridge.listPending()).toHaveLength(0)
  }, 10_000)

  it('returns deny decision after respond() is called with "deny" in default mode', async () => {
    const { app, bridge, token } = makeApp('default')

    const toolUseId = 'test-1-deny'
    const requestBody = {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'bar.ts') },
      tool_use_id: toolUseId,
      session_id: 'session-default-002',
      hook_event_name: 'PreToolUse',
      cwd: tmpDir,
    }

    const responsePromise = postPreToolUse(app, token, requestBody)
    await waitForPending(bridge)
    bridge.respond(toolUseId, 'deny')

    const res = await responsePromise
    expect(res.status).toBe(200)

    const body = await res.json() as { hookSpecificOutput: { permissionDecision: string } }
    expect(body.hookSpecificOutput.permissionDecision).toBe('deny')
  }, 10_000)
})

// ---------------------------------------------------------------------------
// Scenario 2: Protected path detection + bypass mode
// ---------------------------------------------------------------------------

describe('POST /hooks/pre-tool-use — Scenario 2: protected path (.env) forces pending even in bypassPermissions', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'))
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  })

  it('enqueues a .env write in bypassPermissions mode and resolves with allow after respond()', async () => {
    // bypassPermissions normally short-circuits to allow immediately,
    // but .env is a protected path — Step 1 of addPending forces it into the pending queue.
    const { app, bridge, token } = makeApp('bypassPermissions')

    const toolUseId = 'test-2-allow'
    const requestBody = {
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, '.env') },
      tool_use_id: toolUseId,
      session_id: 'session-bypass-001',
      hook_event_name: 'PreToolUse',
      cwd: tmpDir,
    }

    const responsePromise = postPreToolUse(app, token, requestBody)

    // Wait for preflightPaths to detect the protected path and enqueue
    const pendingInfo = await waitForPending(bridge)

    expect(pendingInfo.id).toBe(toolUseId)
    expect(pendingInfo.toolName).toBe('Write')

    // Confirm it's actually in the pending queue (not silently allowed)
    expect(bridge.listPending()).toHaveLength(1)

    // Simulate user approval
    bridge.respond(toolUseId, 'allow')

    const res = await responsePromise
    expect(res.status).toBe(200)

    const body = await res.json() as { hookSpecificOutput: { permissionDecision: string } }
    expect(body.hookSpecificOutput.permissionDecision).toBe('allow')
  }, 10_000)

  it('enqueues a .env write and resolves with deny when user rejects', async () => {
    const { app, bridge, token } = makeApp('bypassPermissions')

    const toolUseId = 'test-2-deny'
    const requestBody = {
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmpDir, '.env') },
      tool_use_id: toolUseId,
      session_id: 'session-bypass-002',
      hook_event_name: 'PreToolUse',
      cwd: tmpDir,
    }

    const responsePromise = postPreToolUse(app, token, requestBody)
    await waitForPending(bridge)
    bridge.respond(toolUseId, 'deny')

    const res = await responsePromise
    expect(res.status).toBe(200)

    const body = await res.json() as { hookSpecificOutput: { permissionDecision: string } }
    expect(body.hookSpecificOutput.permissionDecision).toBe('deny')
  }, 10_000)
})

// ---------------------------------------------------------------------------
// Scenario 3: CLI contract regression — response format stays stable
// ---------------------------------------------------------------------------

describe('POST /hooks/pre-tool-use — Scenario 3: CLI contract (tool_result 파싱 회귀 방지)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'))
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  })

  it('response always contains hookSpecificOutput.permissionDecision (allow path)', async () => {
    // This test guards that the hooks.ts response shape expected by the CLI
    // hook consumer (tool_result parser) has not regressed after T8 refactoring.
    const { app, bridge, token } = makeApp('default')

    const toolUseId = 'test-3-allow'
    const responsePromise = postPreToolUse(app, token, {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'main.ts') },
      tool_use_id: toolUseId,
      session_id: 'session-regression-001',
      hook_event_name: 'PreToolUse',
      cwd: tmpDir,
    })

    await waitForPending(bridge)
    bridge.respond(toolUseId, 'allow')

    const res = await responsePromise
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>

    // CLI contract: top-level key is hookSpecificOutput
    expect(body).toHaveProperty('hookSpecificOutput')
    const out = body['hookSpecificOutput'] as Record<string, unknown>

    // Required fields consumed by Claude CLI's tool_result parser
    expect(out['hookEventName']).toBe('PreToolUse')
    expect(out['permissionDecision']).toBe('allow')
    expect(typeof out['permissionDecisionReason']).toBe('string')
    expect((out['permissionDecisionReason'] as string).length).toBeGreaterThan(0)
  }, 10_000)

  it('response always contains hookSpecificOutput.permissionDecision (deny path)', async () => {
    const { app, bridge, token } = makeApp('default')

    const toolUseId = 'test-3-deny'
    const responsePromise = postPreToolUse(app, token, {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmpDir, 'main.ts') },
      tool_use_id: toolUseId,
      session_id: 'session-regression-002',
      hook_event_name: 'PreToolUse',
      cwd: tmpDir,
    })

    await waitForPending(bridge)
    bridge.respond(toolUseId, 'deny')

    const res = await responsePromise
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    const out = body['hookSpecificOutput'] as Record<string, unknown>

    expect(out['hookEventName']).toBe('PreToolUse')
    expect(out['permissionDecision']).toBe('deny')
    expect(typeof out['permissionDecisionReason']).toBe('string')
    expect((out['permissionDecisionReason'] as string).length).toBeGreaterThan(0)
  }, 10_000)

  it('returns 401 when token is missing or invalid', async () => {
    const { app } = makeApp('default')

    const res = await app.request('/hooks/pre-tool-use?token=wrong-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: '/tmp/foo.ts' },
        tool_use_id: 'test-unauth',
        session_id: 'session-x',
        hook_event_name: 'PreToolUse',
        cwd: '/tmp',
      }),
    })

    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('returns 400 when required fields are missing', async () => {
    const { app, token } = makeApp('default')

    const res = await postPreToolUse(app, token, {
      // missing tool_use_id, session_id, cwd
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/foo.ts' },
      hook_event_name: 'PreToolUse',
    })

    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})
