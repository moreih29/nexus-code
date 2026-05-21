/**
 * ipc-shim-integration.test.ts
 *
 * Acceptance criteria 13-14:
 *  13. spawn → wm.getWrapperBinDir truthy + shell=zsh
 *      → ZDOTDIR/NEXUS_USER_ZDOTDIR injected into env sent to agentHost
 *  14. spawn → wm.getWrapperBinDir null → shim not applied (existing flow preserved)
 *
 * Tests that applyShellPathShim is correctly wired into the pty/ipc.ts spawn path.
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
  env?: Record<string, string>;
}): { handler: IpcHandler; agentChannel: FakeAgentChannel } {
  const agentChannel = new FakeAgentChannel();

  const agentHost = startAgentPtyHost({
    getAgentChannel: async () => agentChannel,
    tryGetAgentChannel: async () => agentChannel,
  });

  const wm: PtyChannelOptions["workspaceManager"] = {
    getName: () => "test-ws",
    activate: async () => {},
    getHookInfo: () => null,
    getAgentChannel: async () => agentChannel,
    getWrapperBinDir: () => opts.wrapperBinDir,
    getWrapperAgentBin: () => null,
  };

  registerPtyChannel({ agentHost, workspaceManager: wm });

  return { handler: getIpcCallHandler(), agentChannel };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("acceptance 13: spawn with zsh + wrapperBinDir → shim env injected", () => {
  test("ZDOTDIR and NEXUS_USER_ZDOTDIR are present in env sent to agentHost (zsh)", async () => {
    const BIN_DIR = "/mock/.nexus-code/bin";
    const { handler, agentChannel } = makeFixture({ wrapperBinDir: BIN_DIR });

    // Pass SHELL=zsh so the shim detects zsh
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
