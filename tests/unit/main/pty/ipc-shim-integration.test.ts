/**
 * ipc-shim-integration.test.ts
 *
 * Acceptance criteria 13-14 (+ 15):
 *  13. spawn → wm.getWrapperBinDir truthy + wm.getWrapperShell="/bin/zsh"
 *      → ZDOTDIR/NEXUS_USER_ZDOTDIR injected into env sent to agentHost
 *  14. spawn → wm.getWrapperBinDir null → shim not applied (existing flow preserved)
 *  15. spawn → wm.getWrapperBinDir truthy + wm.getWrapperShell=null
 *      → shim not applied; PATH prepend still occurs (NEXUS_WRAPPER_SELF_DIR set)
 *
 * Tests that applyShellPathShim is correctly wired into the pty/ipc.ts spawn
 * path and that the shell resolution comes from WorkspaceManager, not from
 * renderer-supplied env.SHELL.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
  ChannelLifecycleEvent,
} from "../../../../src/main/infra/agent/channel";
import type { PtyChannelOptions } from "../../../../src/main/features/pty/ipc";

// ---------------------------------------------------------------------------
// electron mock
// ---------------------------------------------------------------------------

const mockHandle = mock((_channel: string, _handler: unknown) => {});
const mockOn = mock((_channel: string, _handler: unknown) => {});
const mockSend = mock((..._args: unknown[]) => {});
const mockGetAllWebContents = mock(() => [{ isDestroyed: () => false, send: mockSend }]);

mock.module("electron", () => ({
  app: { isPackaged: false },
  ipcMain: { handle: mockHandle, on: mockOn },
  webContents: { getAllWebContents: mockGetAllWebContents },
}));

// ---------------------------------------------------------------------------
// Dynamic imports
// ---------------------------------------------------------------------------

const { setupRouter } = await import("../../../../src/main/infra/ipc-router");
const { startAgentPtyHost } = await import("../../../../src/main/features/pty/agent-host");
const { registerPtyChannel } = await import("../../../../src/main/features/pty/ipc");

setupRouter();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKSPACE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TAB_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type IpcHandler = (
  event: { sender?: { id?: number } },
  channelName: string,
  method: string,
  args: unknown,
  requestId?: unknown,
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// FakeAgentChannel — captures env/args sent to pty.spawn
// ---------------------------------------------------------------------------

class FakeAgentChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly spawnCalls: Array<{ env?: Record<string, string>; args?: string[] }> = [];
  private readonly eventListeners = new Map<string, Set<ChannelEventCallback>>();
  private readonly lifecycleListeners = new Set<ChannelLifecycleCallback>();

  async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    if (method === "pty.spawn") {
      const p = params as { env?: Record<string, string>; args?: string[] };
      this.spawnCalls.push({ env: p.env, args: p.args });
      return { pid: 42 } as TResult;
    }
    return {} as TResult;
  }

  fire(_method: string, _params?: unknown): void {}

  on(event: string, callback: ChannelEventCallback): () => void {
    let listeners = this.eventListeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(event, listeners);
    }
    listeners.add(callback);
    return () => listeners?.delete(callback);
  }

  onLifecycle(callback: ChannelLifecycleCallback): () => void {
    this.lifecycleListeners.add(callback);
    return () => this.lifecycleListeners.delete(callback);
  }

  emitLifecycle(event: ChannelLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) listener(event);
  }

  dispose(): void {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getIpcCallHandler(): IpcHandler {
  const calls = mockHandle.mock.calls as [string, IpcHandler][];
  const entry = calls.filter(([channel]) => channel === "ipc:call").at(-1);
  if (!entry) throw new Error("ipcMain.handle('ipc:call') was not called");
  return entry[1];
}

function makeFixture(opts: {
  wrapperBinDir: string | null;
  wrapperShell?: string | null;
  wrapperShimDir?: string | null;
  env?: Record<string, string>;
}): { handler: IpcHandler; agentChannel: FakeAgentChannel } {
  const agentChannel = new FakeAgentChannel();

  const agentHost = startAgentPtyHost({
    getAgentChannel: async () => agentChannel,
    tryGetAgentChannel: async () => agentChannel,
  });

  // Default shell — most acceptance tests want the shim to fire on zsh.
  // Callers that exercise the shell=null skip path pass wrapperShell: null
  // explicitly.
  const wrapperShell =
    opts.wrapperShell === undefined ? "/bin/zsh" : opts.wrapperShell;
  // Default shim dir — mimics what WorkspaceManager.getWrapperShimDir would
  // return for a local workspace. Tests that need to exercise the
  // shimDir=null skip path pass null explicitly.
  const wrapperShimDir =
    opts.wrapperShimDir === undefined
      ? `/mock/.nexus-code/shim/${WORKSPACE_ID}`
      : opts.wrapperShimDir;

  const wm: PtyChannelOptions["workspaceManager"] = {
    getName: () => "test-ws",
    activate: async () => {},
    getHookInfo: () => null,
    getAgentChannel: async () => agentChannel,
    getWrapperBinDir: () => opts.wrapperBinDir,
    getWrapperAgentBin: () => null,
    getWrapperShell: () => wrapperShell,
    getWrapperShimDir: () => wrapperShimDir,
  };

  registerPtyChannel({ agentHost, workspaceManager: wm });

  return { handler: getIpcCallHandler(), agentChannel };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("acceptance 13: spawn with zsh + wrapperBinDir → shim env injected", () => {
  test("ZDOTDIR and NEXUS_USER_ZDOTDIR are present in env sent to agentHost (zsh from wm.getWrapperShell)", async () => {
    const BIN_DIR = "/mock/.nexus-code/bin";
    const { handler, agentChannel } = makeFixture({
      wrapperBinDir: BIN_DIR,
      wrapperShell: "/bin/zsh",
    });

    // Note: caller env does NOT include SHELL — proving that the shim now
    // relies on wm.getWrapperShell rather than env.SHELL (the actual bug we
    // fixed: renderer never forwards SHELL).
    const spawnArgsPayload = {
      workspaceId: WORKSPACE_ID,
      tabId: TAB_ID,
      cwd: "/repo",
      cols: 80,
      rows: 24,
      env: { PATH: "/usr/bin" },
    };

    await handler({}, "pty", "spawn", spawnArgsPayload);

    expect(agentChannel.spawnCalls).toHaveLength(1);
    const sentEnv = agentChannel.spawnCalls[0].env!;

    // Shim must have redirected ZDOTDIR
    expect(sentEnv.ZDOTDIR).toBeDefined();
    // ZDOTDIR must point to the shim directory (contains workspaceId)
    expect(sentEnv.ZDOTDIR).toContain(WORKSPACE_ID);
    // NEXUS_USER_ZDOTDIR must be present
    expect(sentEnv.NEXUS_USER_ZDOTDIR).toBeDefined();
  });
});

describe("acceptance 14: spawn with wrapperBinDir=null → shim not applied", () => {
  test("ZDOTDIR and NEXUS_USER_ZDOTDIR are NOT injected when wrapperBinDir is null", async () => {
    const { handler, agentChannel } = makeFixture({ wrapperBinDir: null });

    const spawnArgsPayload = {
      workspaceId: WORKSPACE_ID,
      tabId: TAB_ID,
      cwd: "/repo",
      cols: 80,
      rows: 24,
      env: { SHELL: "/bin/zsh", PATH: "/usr/bin" },
    };

    await handler({}, "pty", "spawn", spawnArgsPayload);

    expect(agentChannel.spawnCalls).toHaveLength(1);
    const sentEnv = agentChannel.spawnCalls[0].env!;

    // Shim must NOT have run — ZDOTDIR should not be the shim dir
    // (it may be undefined or the original value from the caller env, but not a shim path)
    expect(sentEnv.ZDOTDIR).toBeUndefined();
    expect(sentEnv.NEXUS_USER_ZDOTDIR).toBeUndefined();
    // Also wrapper env should not be injected
    expect(sentEnv.NEXUS_IN_APP).toBeUndefined();
  });
});

describe("acceptance 15: spawn with wrapperBinDir truthy + wrapperShell=null → shim skipped, PATH prepend still applies", () => {
  test("ZDOTDIR is not injected but NEXUS_WRAPPER_SELF_DIR / PATH prepend still apply", async () => {
    const BIN_DIR = "/mock/.nexus-code/bin";
    const { handler, agentChannel } = makeFixture({
      wrapperBinDir: BIN_DIR,
      wrapperShell: null,
    });

    // Note: caller env is intentionally omitted so that harness-env's base
    // PATH (with wrapper bin prepended) is not overridden by a caller-provided
    // PATH. The intent here is to verify that wrapperShell=null skips ZDOTDIR
    // injection while keeping the PATH prepend / NEXUS_* env intact.
    const spawnArgsPayload = {
      workspaceId: WORKSPACE_ID,
      tabId: TAB_ID,
      cwd: "/repo",
      cols: 80,
      rows: 24,
    };

    await handler({}, "pty", "spawn", spawnArgsPayload);

    expect(agentChannel.spawnCalls).toHaveLength(1);
    const sentEnv = agentChannel.spawnCalls[0].env!;

    // Shim should NOT have run (no shell info)
    expect(sentEnv.ZDOTDIR).toBeUndefined();
    expect(sentEnv.NEXUS_USER_ZDOTDIR).toBeUndefined();
    // ...but PATH prepend + wrapper env should still apply.
    expect(sentEnv.NEXUS_WRAPPER_SELF_DIR).toBe(BIN_DIR);
    expect(sentEnv.NEXUS_IN_APP).toBe("1");
    expect(sentEnv.PATH?.startsWith(BIN_DIR)).toBe(true);
  });
});
