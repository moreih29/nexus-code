import { describe, expect, mock, test } from "bun:test";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
  ChannelLifecycleEvent,
} from "../../../../src/main/infra/agent/channel";
import type { PtyHostHandle } from "../../../../src/main/features/pty/host";
import type { PtyRouteOptions, PtyWorkspaceManager } from "../../../../src/main/features/pty/ipc";
import type { PtyRecorderSink } from "../../../../src/main/features/pty/recorder";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

const mockHandle = mock((_channel: string, _handler: unknown) => {});
const mockOn = mock((_channel: string, _handler: unknown) => {});
const mockSend = mock((..._args: unknown[]) => {});
const mockGetAllWebContents = mock(() => [{ isDestroyed: () => false, send: mockSend }]);

mock.module("electron", () => ({
  ipcMain: {
    handle: mockHandle,
    on: mockOn,
  },
  webContents: {
    getAllWebContents: mockGetAllWebContents,
  },
}));

const { setupRouter } = await import("../../../../src/main/infra/ipc/router");
const { startAgentPtyHost } = await import("../../../../src/main/features/pty/agent-host");
const { registerPtyChannel } = await import("../../../../src/main/features/pty/ipc");

setupRouter();

const LOCAL_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SSH_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const TAB_ID = "33333333-3333-4333-8333-333333333333";

type IpcHandler = (
  event: { sender?: { id?: number } },
  channelName: string,
  method: string,
  args: unknown,
  requestId?: unknown,
) => Promise<unknown>;

/**
 * FakePtyHost records calls and allows tests to emit utility-host events.
 */
class FakePtyHost implements PtyHostHandle {
  readonly calls: Array<{ method: string; args: unknown }> = [];
  private readonly listeners = new Map<string, Set<(args: unknown) => void>>();

  async call(method: string, args: unknown): Promise<unknown> {
    this.calls.push({ method, args });
    return method === "spawn" ? { pid: 101 } : undefined;
  }

  on(event: string, cb: (args: unknown) => void): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(cb);
    return () => listeners?.delete(cb);
  }

  emit(event: string, args: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(args);
    }
  }

  isAlive(): boolean {
    return true;
  }

  dispose(): void {}
}

/**
 * FakeAgentChannel models the workspace-scoped Go agent channel.
 */
class FakeAgentChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly calls: Array<{ method: string; params: unknown }> = [];
  private readonly eventListeners = new Map<string, Set<ChannelEventCallback>>();
  private readonly lifecycleListeners = new Set<ChannelLifecycleCallback>();

  async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    this.calls.push({ method, params });
    return (method === "pty.spawn" ? { pid: 202 } : {}) as TResult;
  }

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

  emit(event: string, payload: unknown): void {
    for (const listener of this.eventListeners.get(event) ?? []) {
      listener(payload);
    }
  }

  emitLifecycle(event: ChannelLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      listener(event);
    }
  }

  dispose(): void {}
}

/**
 * FakeRecorder captures main-side recorder calls without touching utility behavior.
 */
class FakeRecorder implements PtyRecorderSink {
  readonly starts: Array<{ workspaceId: string; tabId: string; cols: number; rows: number }> = [];
  readonly data: Array<{ workspaceId: string; tabId: string; chunk: string }> = [];
  readonly resizes: Array<{ workspaceId: string; tabId: string; cols: number; rows: number }> = [];
  readonly stops: Array<{ workspaceId: string; tabId: string }> = [];

  start(workspaceId: string, tabId: string, cols: number, rows: number): void {
    this.starts.push({ workspaceId, tabId, cols, rows });
  }

  appendData(workspaceId: string, tabId: string, chunk: string): void {
    this.data.push({ workspaceId, tabId, chunk });
  }

  handleResize(workspaceId: string, tabId: string, cols: number, rows: number): void {
    this.resizes.push({ workspaceId, tabId, cols, rows });
  }

  stop(workspaceId: string, tabId: string): void {
    this.stops.push({ workspaceId, tabId });
  }
}

/**
 * Returns the ipc:call handler captured by the mocked Electron router.
 */
function getIpcCallHandler(): IpcHandler {
  const calls = mockHandle.mock.calls as [string, IpcHandler][];
  const entry = calls.filter(([channel]) => channel === "ipc:call").at(-1);
  if (!entry) throw new Error("ipcMain.handle('ipc:call') was not called");
  return entry[1];
}

/**
 * Creates a registered PTY channel with controllable workspace kind and flag.
 */
function makeFixture(ptyViaAgent: boolean): {
  handler: IpcHandler;
  utilityHost: FakePtyHost;
  agentChannel: FakeAgentChannel;
  recorder: FakeRecorder;
} {
  const utilityHost = new FakePtyHost();
  const agentChannel = new FakeAgentChannel();
  const recorder = new FakeRecorder();
  const agentHost = startAgentPtyHost({
    getAgentChannel: async () => agentChannel,
  });
  const workspaceManager: PtyWorkspaceManager = {
    requireContext: (workspaceId: string) => ({
      getMeta: () => workspaceMeta(workspaceId === SSH_WORKSPACE_ID ? "ssh" : "local"),
    }),
  };
  const options: PtyRouteOptions = {
    agentHost,
    workspaceManager,
    stateService: {
      getState: () => ({ experimental: { ptyViaAgent } }),
    },
    recorder,
  };
  registerPtyChannel(utilityHost, options);
  return { handler: getIpcCallHandler(), utilityHost, agentChannel, recorder };
}

/**
 * Builds the minimal workspace metadata needed by PTY route selection.
 */
function workspaceMeta(kind: "local" | "ssh"): WorkspaceMeta {
  return {
    id: kind === "ssh" ? SSH_WORKSPACE_ID : LOCAL_WORKSPACE_ID,
    name: kind,
    location:
      kind === "ssh"
        ? { kind: "ssh", host: "example.test", remotePath: "/repo" }
        : { kind: "local", rootPath: "/repo" },
    rootPath: "/repo",
    colorTone: "default",
    pinned: false,
    tabs: [],
  };
}

/**
 * Builds a valid pty.spawn request.
 */
function spawnArgs(workspaceId: string, tabId = TAB_ID): unknown {
  return { workspaceId, tabId, cwd: "/repo", cols: 80, rows: 24 };
}

describe("registerPtyChannel route selection", () => {
  test("flag=false local workspace routes to utility host", async () => {
    const { handler, utilityHost, agentChannel } = makeFixture(false);

    const result = await handler({}, "pty", "spawn", spawnArgs(LOCAL_WORKSPACE_ID));

    expect(result).toEqual({ pid: 101 });
    expect(utilityHost.calls.map((call) => call.method)).toContain("spawn");
    expect(agentChannel.calls).toHaveLength(0);
  });

  test("flag=false SSH workspace routes to agent host", async () => {
    const { handler, utilityHost, agentChannel } = makeFixture(false);

    const result = await handler({}, "pty", "spawn", spawnArgs(SSH_WORKSPACE_ID));

    expect(result).toEqual({ pid: 202 });
    expect(utilityHost.calls).toHaveLength(0);
    expect(agentChannel.calls[0]).toMatchObject({ method: "pty.spawn" });
  });

  test("flag=true local workspace routes to agent host", async () => {
    const { handler, utilityHost, agentChannel } = makeFixture(true);

    const result = await handler({}, "pty", "spawn", spawnArgs(LOCAL_WORKSPACE_ID));

    expect(result).toEqual({ pid: 202 });
    expect(utilityHost.calls).toHaveLength(0);
    expect(agentChannel.calls[0]).toMatchObject({ method: "pty.spawn" });
  });
});

describe("registerPtyChannel PTY ack routing", () => {
  test("agent sessions forward bytesConsumed to pty.ack", async () => {
    const { handler, agentChannel } = makeFixture(true);
    await handler({}, "pty", "spawn", spawnArgs(LOCAL_WORKSPACE_ID));
    agentChannel.calls.length = 0;

    await handler({}, "pty", "ack", {
      workspaceId: LOCAL_WORKSPACE_ID,
      tabId: TAB_ID,
      bytesConsumed: 17,
    });

    expect(agentChannel.calls).toEqual([
      {
        method: "pty.ack",
        params: { workspaceId: LOCAL_WORKSPACE_ID, tabId: TAB_ID, bytesConsumed: 17 },
      },
    ]);
  });

  test("utility sessions preserve legacy charCount ack payload", async () => {
    const { handler, utilityHost } = makeFixture(false);
    await handler({}, "pty", "spawn", spawnArgs(LOCAL_WORKSPACE_ID));
    utilityHost.calls.length = 0;

    await handler({}, "pty", "ack", {
      workspaceId: LOCAL_WORKSPACE_ID,
      tabId: TAB_ID,
      bytesConsumed: 17,
    });

    expect(utilityHost.calls).toEqual([
      {
        method: "ack",
        args: { workspaceId: LOCAL_WORKSPACE_ID, tabId: TAB_ID, charCount: 17 },
      },
    ]);
  });
});

describe("registerPtyChannel agent events", () => {
  test("forwards agent data without synthesizing ack", async () => {
    const { handler, agentChannel, recorder } = makeFixture(true);
    await handler({}, "pty", "spawn", spawnArgs(LOCAL_WORKSPACE_ID));
    agentChannel.calls.length = 0;
    mockSend.mockClear();

    agentChannel.emit("pty.data", {
      workspaceId: LOCAL_WORKSPACE_ID,
      tabId: TAB_ID,
      chunk: Buffer.from("hello", "utf8").toString("base64"),
    });

    expect(mockSend).toHaveBeenCalledWith("ipc:event", "pty", "data", {
      workspaceId: LOCAL_WORKSPACE_ID,
      tabId: TAB_ID,
      chunk: "hello",
    });
    expect(recorder.data).toEqual([
      { workspaceId: LOCAL_WORKSPACE_ID, tabId: TAB_ID, chunk: "hello" },
    ]);
    expect(agentChannel.calls.some((call) => call.method === "pty.ack")).toBe(false);
  });

  test("streams UTF-8 decoding across split base64 PTY chunks", async () => {
    const { handler, agentChannel } = makeFixture(true);
    await handler({}, "pty", "spawn", spawnArgs(LOCAL_WORKSPACE_ID));
    mockSend.mockClear();

    agentChannel.emit("pty.data", {
      workspaceId: LOCAL_WORKSPACE_ID,
      tabId: TAB_ID,
      chunk: Buffer.from([0xe2, 0x82]).toString("base64"),
    });
    expect(mockSend).not.toHaveBeenCalled();

    agentChannel.emit("pty.data", {
      workspaceId: LOCAL_WORKSPACE_ID,
      tabId: TAB_ID,
      chunk: Buffer.from([0xac]).toString("base64"),
    });
    expect(mockSend).toHaveBeenCalledWith("ipc:event", "pty", "data", {
      workspaceId: LOCAL_WORKSPACE_ID,
      tabId: TAB_ID,
      chunk: "€",
    });
  });

  for (const lifecycle of [
    { type: "failure", error: new Error("boom") } as const,
    { type: "exit", code: 0, signal: null } as const,
  ]) {
    test(`broadcasts code=null exits for known sessions on channel ${lifecycle.type}`, async () => {
      const { handler, agentChannel } = makeFixture(true);
      const tabA = "44444444-4444-4444-8444-444444444444";
      const tabB = "55555555-5555-4555-8555-555555555555";
      await handler({}, "pty", "spawn", spawnArgs(LOCAL_WORKSPACE_ID, tabA));
      await handler({}, "pty", "spawn", spawnArgs(LOCAL_WORKSPACE_ID, tabB));
      mockSend.mockClear();

      agentChannel.emitLifecycle(lifecycle);

      expect(mockSend).toHaveBeenCalledWith("ipc:event", "pty", "exit", {
        workspaceId: LOCAL_WORKSPACE_ID,
        tabId: tabA,
        code: null,
      });
      expect(mockSend).toHaveBeenCalledWith("ipc:event", "pty", "exit", {
        workspaceId: LOCAL_WORKSPACE_ID,
        tabId: tabB,
        code: null,
      });
    });
  }
});

describe("registerPtyChannel recorder routing", () => {
  test("starts and resizes the main recorder for agent sessions", async () => {
    const { handler, recorder } = makeFixture(true);

    await handler({}, "pty", "spawn", spawnArgs(LOCAL_WORKSPACE_ID));
    await handler({}, "pty", "resize", {
      workspaceId: LOCAL_WORKSPACE_ID,
      tabId: TAB_ID,
      cols: 100,
      rows: 30,
    });

    expect(recorder.starts).toEqual([
      { workspaceId: LOCAL_WORKSPACE_ID, tabId: TAB_ID, cols: 80, rows: 24 },
    ]);
    expect(recorder.resizes).toEqual([
      { workspaceId: LOCAL_WORKSPACE_ID, tabId: TAB_ID, cols: 100, rows: 30 },
    ]);
  });

  test("does not start or append the main recorder for utility sessions", async () => {
    const { handler, utilityHost, recorder } = makeFixture(false);
    await handler({}, "pty", "spawn", spawnArgs(LOCAL_WORKSPACE_ID));
    mockSend.mockClear();

    utilityHost.emit("data", { tabId: TAB_ID, chunk: "utility-owned" });

    expect(mockSend).toHaveBeenCalledWith("ipc:event", "pty", "data", {
      workspaceId: LOCAL_WORKSPACE_ID,
      tabId: TAB_ID,
      chunk: "utility-owned",
    });
    expect(recorder.starts).toHaveLength(0);
    expect(recorder.data).toHaveLength(0);
  });

  test("stops the main recorder when an agent session exits", async () => {
    const { handler, agentChannel, recorder } = makeFixture(true);
    await handler({}, "pty", "spawn", spawnArgs(LOCAL_WORKSPACE_ID));

    agentChannel.emit("pty.exit", {
      workspaceId: LOCAL_WORKSPACE_ID,
      tabId: TAB_ID,
      code: 0,
    });

    expect(recorder.stops).toEqual([{ workspaceId: LOCAL_WORKSPACE_ID, tabId: TAB_ID }]);
  });
});

describe("registerPtyChannel kill cleanup (W1)", () => {
  test("removes workspaceIdByTabId and routeBySession entries immediately on kill", async () => {
    // After kill, a follow-up utility exit event must not route — the session
    // maps must already be empty.
    const { handler, utilityHost } = makeFixture(false);
    await handler({}, "pty", "spawn", spawnArgs(LOCAL_WORKSPACE_ID));
    mockSend.mockClear();

    await handler({}, "pty", "kill", { workspaceId: LOCAL_WORKSPACE_ID, tabId: TAB_ID });

    // Emit a utility exit after kill — should be dropped because the tab is
    // no longer in workspaceIdByTabId.
    utilityHost.emit("exit", { tabId: TAB_ID, code: 0 });

    // broadcast should NOT have been called for this stale exit.
    expect(
      mockSend.mock.calls.some(
        (call) =>
          call[1] === "pty" &&
          call[2] === "exit" &&
          (call[3] as { tabId?: string })?.tabId === TAB_ID,
      ),
    ).toBe(false);
  });

  test("removes routeBySession entry for agent session immediately on kill", async () => {
    // Spawn an agent session, kill it, then confirm a subsequent exit event
    // on the agent channel does not broadcast a second exit.
    const { handler, agentChannel } = makeFixture(false);
    await handler({}, "pty", "spawn", spawnArgs(SSH_WORKSPACE_ID));
    mockSend.mockClear();

    await handler({}, "pty", "kill", { workspaceId: SSH_WORKSPACE_ID, tabId: TAB_ID });

    // Emit an agent exit after kill — should be dropped (route entry gone).
    agentChannel.emit("pty.exit", {
      workspaceId: SSH_WORKSPACE_ID,
      tabId: TAB_ID,
      code: null,
    });

    expect(
      mockSend.mock.calls.some(
        (call) =>
          call[1] === "pty" &&
          call[2] === "exit" &&
          (call[3] as { tabId?: string })?.tabId === TAB_ID,
      ),
    ).toBe(false);
  });
});

describe("agentPtyHost dispose broadcasts pty.exit (W2)", () => {
  test("dispose emits pty.exit code=null for each active session", async () => {
    const agentChannel = new FakeAgentChannel();
    const agentHost = startAgentPtyHost({ getAgentChannel: async () => agentChannel });

    const exits: Array<unknown> = [];
    agentHost.on("exit", (args) => exits.push(args));

    const tabA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const tabB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const workspaceId = LOCAL_WORKSPACE_ID;

    await agentHost.call("spawn", {
      workspaceId,
      tabId: tabA,
      cwd: "/repo",
      shell: "/bin/sh",
      cols: 80,
      rows: 24,
    });
    await agentHost.call("spawn", {
      workspaceId,
      tabId: tabB,
      cwd: "/repo",
      shell: "/bin/sh",
      cols: 80,
      rows: 24,
    });

    agentHost.dispose();

    expect(exits).toHaveLength(2);
    expect(exits).toContainEqual({ workspaceId, tabId: tabA, code: null });
    expect(exits).toContainEqual({ workspaceId, tabId: tabB, code: null });
  });

  test("dispose emits no pty.exit when there are no active sessions", () => {
    const agentChannel = new FakeAgentChannel();
    const agentHost = startAgentPtyHost({ getAgentChannel: async () => agentChannel });
    const exits: Array<unknown> = [];
    agentHost.on("exit", (args) => exits.push(args));

    agentHost.dispose();

    expect(exits).toHaveLength(0);
  });
});

describe("routeForNewSession SSH without agentHost throws (W3)", () => {
  test("SSH workspace with agentHost=undefined throws on spawn", async () => {
    const utilityHost = new FakePtyHost();
    const agentChannel = new FakeAgentChannel();
    const workspaceManager: PtyWorkspaceManager = {
      requireContext: (workspaceId: string) => ({
        getMeta: () => workspaceMeta(workspaceId === SSH_WORKSPACE_ID ? "ssh" : "local"),
      }),
    };
    // Intentionally omit agentHost to exercise the guard.
    const options: PtyRouteOptions = {
      agentHost: undefined,
      workspaceManager,
      stateService: { getState: () => ({ experimental: { ptyViaAgent: false } }) },
    };
    registerPtyChannel(utilityHost, options);
    const handler = getIpcCallHandler();

    // Suppress the unused variable warning; agentChannel is only used by
    // other fixtures and is referenced here to prevent tree-shaking.
    void agentChannel;

    await expect(handler({}, "pty", "spawn", spawnArgs(SSH_WORKSPACE_ID))).rejects.toThrow(
      "SSH workspace requires the agent PTY host but it is not configured",
    );
  });
});
