import { describe, expect, mock, test } from "bun:test";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
  ChannelLifecycleEvent,
} from "../../../../src/main/infra/agent/channel";
import type { PtyChannelOptions } from "../../../../src/main/features/pty/ipc";
import type { PtyRecorderSink } from "../../../../src/main/features/pty/recorder";

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
 * FakeRecorder captures main-side recorder calls for assertion.
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
 * Creates a registered PTY channel backed by the agent host.
 */
function makeFixture(): {
  handler: IpcHandler;
  agentChannel: FakeAgentChannel;
  recorder: FakeRecorder;
} {
  const agentChannel = new FakeAgentChannel();
  const recorder = new FakeRecorder();
  const agentHost = startAgentPtyHost({
    getAgentChannel: async () => agentChannel,
  });
  const options: PtyChannelOptions = { agentHost, recorder };
  registerPtyChannel(options);
  return { handler: getIpcCallHandler(), agentChannel, recorder };
}

/**
 * Builds a valid pty.spawn request.
 */
function spawnArgs(workspaceId: string, tabId = TAB_ID): unknown {
  return { workspaceId, tabId, cwd: "/repo", cols: 80, rows: 24 };
}

describe("registerPtyChannel agent lifecycle", () => {
  test("spawn routes to agent host and returns pid", async () => {
    const { handler, agentChannel } = makeFixture();

    const result = await handler({}, "pty", "spawn", spawnArgs(LOCAL_WORKSPACE_ID));

    expect(result).toEqual({ pid: 202 });
    expect(agentChannel.calls[0]).toMatchObject({ method: "pty.spawn" });
  });

  test("write forwards to agent host", async () => {
    const { handler, agentChannel } = makeFixture();
    await handler({}, "pty", "spawn", spawnArgs(LOCAL_WORKSPACE_ID));
    agentChannel.calls.length = 0;

    await handler({}, "pty", "write", {
      workspaceId: LOCAL_WORKSPACE_ID,
      tabId: TAB_ID,
      data: "hello",
    });

    expect(agentChannel.calls).toEqual([
      { method: "pty.write", params: { workspaceId: LOCAL_WORKSPACE_ID, tabId: TAB_ID, data: "hello" } },
    ]);
  });

  test("resize forwards to agent host and records resize", async () => {
    const { handler, agentChannel, recorder } = makeFixture();
    await handler({}, "pty", "spawn", spawnArgs(LOCAL_WORKSPACE_ID));
    agentChannel.calls.length = 0;

    await handler({}, "pty", "resize", {
      workspaceId: LOCAL_WORKSPACE_ID,
      tabId: TAB_ID,
      cols: 100,
      rows: 30,
    });

    expect(agentChannel.calls).toEqual([
      { method: "pty.resize", params: { workspaceId: LOCAL_WORKSPACE_ID, tabId: TAB_ID, cols: 100, rows: 30 } },
    ]);
    expect(recorder.resizes).toEqual([
      { workspaceId: LOCAL_WORKSPACE_ID, tabId: TAB_ID, cols: 100, rows: 30 },
    ]);
  });

  test("ack sends bytesConsumed to agent host", async () => {
    const { handler, agentChannel } = makeFixture();
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

  test("kill forwards to agent host", async () => {
    const { handler, agentChannel } = makeFixture();
    await handler({}, "pty", "spawn", spawnArgs(LOCAL_WORKSPACE_ID));
    agentChannel.calls.length = 0;

    await handler({}, "pty", "kill", { workspaceId: LOCAL_WORKSPACE_ID, tabId: TAB_ID });

    expect(agentChannel.calls).toEqual([
      { method: "pty.kill", params: { workspaceId: LOCAL_WORKSPACE_ID, tabId: TAB_ID } },
    ]);
  });

  test("SSH workspace also routes to agent host", async () => {
    const { handler, agentChannel } = makeFixture();

    const result = await handler({}, "pty", "spawn", spawnArgs(SSH_WORKSPACE_ID));

    expect(result).toEqual({ pid: 202 });
    expect(agentChannel.calls[0]).toMatchObject({ method: "pty.spawn" });
  });
});

describe("registerPtyChannel agent events", () => {
  test("forwards agent data to renderer and recorder", async () => {
    const { handler, agentChannel, recorder } = makeFixture();
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
    const { handler, agentChannel } = makeFixture();
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
      const { handler, agentChannel } = makeFixture();
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

describe("registerPtyChannel recorder", () => {
  test("starts recorder on spawn and stops on exit", async () => {
    const { handler, agentChannel, recorder } = makeFixture();

    await handler({}, "pty", "spawn", spawnArgs(LOCAL_WORKSPACE_ID));

    expect(recorder.starts).toEqual([
      { workspaceId: LOCAL_WORKSPACE_ID, tabId: TAB_ID, cols: 80, rows: 24 },
    ]);

    agentChannel.emit("pty.exit", {
      workspaceId: LOCAL_WORKSPACE_ID,
      tabId: TAB_ID,
      code: 0,
    });

    expect(recorder.stops).toEqual([{ workspaceId: LOCAL_WORKSPACE_ID, tabId: TAB_ID }]);
  });

  test("stops recorder when spawn call throws", async () => {
    const agentChannel = new FakeAgentChannel();
    const recorder = new FakeRecorder();
    // Override call so spawn always rejects.
    agentChannel.call = async (method: string) => {
      if (method === "pty.spawn") throw new Error("agent error");
      return {};
    };
    const agentHost = startAgentPtyHost({ getAgentChannel: async () => agentChannel });
    registerPtyChannel({ agentHost, recorder });
    const handler = getIpcCallHandler();

    await expect(handler({}, "pty", "spawn", spawnArgs(LOCAL_WORKSPACE_ID))).rejects.toThrow(
      "agent error",
    );

    expect(recorder.stops).toEqual([{ workspaceId: LOCAL_WORKSPACE_ID, tabId: TAB_ID }]);
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
