/**
 * acceptance #8: pty/ipc.ts spawn — WorkspaceManager getter null 결과 시
 * wrapper 관련 env 주입 skip, 기존 로컬 흐름 정상.
 *
 * getWrapperBinDir / getWrapperAgentBin이 null을 반환하면
 * injectHarnessTerminalEnv가 context 없이 호출되어 NEXUS_WRAPPER_SELF_DIR,
 * NEXUS_AGENT_BIN이 설정되지 않아야 한다.
 *
 * getWrapperBinDir가 유효 경로를 반환하면 PATH에 해당 경로가 prepend되어야 한다.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
  ChannelLifecycleEvent,
} from "../../../../src/main/infra/agent/channel";
import type { PtyChannelOptions } from "../../../../src/main/features/pty/ipc";

const mockHandle = mock((_channel: string, _handler: unknown) => {});
const mockOn = mock((_channel: string, _handler: unknown) => {});
const mockSend = mock((..._args: unknown[]) => {});
const mockGetAllWebContents = mock(() => [{ isDestroyed: () => false, send: mockSend }]);

mock.module("electron", () => ({
  app: {
    isPackaged: false,
  },
  ipcMain: {
    handle: mockHandle,
    on: mockOn,
  },
  webContents: {
    getAllWebContents: mockGetAllWebContents,
  },
}));

const { setupRouter } = await import("../../../../src/main/infra/ipc-router");
const { startAgentPtyHost } = await import("../../../../src/main/features/pty/agent-host");
const { registerPtyChannel } = await import("../../../../src/main/features/pty/ipc");

setupRouter();

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TAB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type IpcHandler = (
  event: { sender?: { id?: number } },
  channelName: string,
  method: string,
  args: unknown,
  requestId?: unknown,
) => Promise<unknown>;

class FakeAgentChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly calls: Array<{ method: string; params: unknown }> = [];
  private readonly eventListeners = new Map<string, Set<ChannelEventCallback>>();
  private readonly lifecycleListeners = new Set<ChannelLifecycleCallback>();

  async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    this.calls.push({ method, params });
    return (method === "pty.spawn" ? { pid: 303 } : {}) as TResult;
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

function getIpcCallHandler(): IpcHandler {
  const calls = mockHandle.mock.calls as [string, IpcHandler][];
  const entry = calls.filter(([channel]) => channel === "ipc:call").at(-1);
  if (!entry) throw new Error("ipcMain.handle('ipc:call') was not called");
  return entry[1];
}

function makeFixtureWithManager(opts: {
  wrapperBinDir: string | null;
  wrapperAgentBin: string | null;
}): { handler: IpcHandler; spawnedEnv: () => Record<string, string> | undefined } {
  const agentChannel = new FakeAgentChannel();
  let capturedEnv: Record<string, string> | undefined;

  // Intercept the env passed to pty.spawn
  const origCall = agentChannel.call.bind(agentChannel);
  agentChannel.call = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "pty.spawn") {
      capturedEnv = (params as { env?: Record<string, string> })?.env;
    }
    return origCall<T>(method, params);
  };

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
    getWrapperAgentBin: () => opts.wrapperAgentBin,
  };

  const options: PtyChannelOptions = { agentHost, workspaceManager: wm };
  registerPtyChannel(options);

  return {
    handler: getIpcCallHandler(),
    spawnedEnv: () => capturedEnv,
  };
}

function spawnArgs(): unknown {
  return { workspaceId: WORKSPACE_ID, tabId: TAB_ID, cwd: "/repo", cols: 80, rows: 24 };
}

describe("acceptance #8: spawn env injection — wrapper getter null 시 skip", () => {
  test("getWrapperBinDir=null → NEXUS_WRAPPER_SELF_DIR / NEXUS_IN_APP 미주입", async () => {
    const { handler, spawnedEnv } = makeFixtureWithManager({
      wrapperBinDir: null,
      wrapperAgentBin: null,
    });

    await handler({}, "pty", "spawn", spawnArgs());
    const env = spawnedEnv();

    expect(env).toBeDefined();
    expect(env!.NEXUS_WRAPPER_SELF_DIR).toBeUndefined();
    expect(env!.NEXUS_IN_APP).toBeUndefined();
    expect(env!.NEXUS_AGENT_BIN).toBeUndefined();
  });

  test("getWrapperBinDir='/remote/bin' → PATH prepend + NEXUS_WRAPPER_SELF_DIR 설정", async () => {
    const BIN_DIR = "/remote/.nexus-code/bin";
    const { handler, spawnedEnv } = makeFixtureWithManager({
      wrapperBinDir: BIN_DIR,
      wrapperAgentBin: `${BIN_DIR}/agent-0.1.0-linux-amd64`,
    });

    await handler({}, "pty", "spawn", spawnArgs());
    const env = spawnedEnv();

    expect(env).toBeDefined();
    expect(env!.NEXUS_WRAPPER_SELF_DIR).toBe(BIN_DIR);
    expect(env!.NEXUS_IN_APP).toBe("1");
    expect(env!.NEXUS_AGENT_BIN).toBe(`${BIN_DIR}/agent-0.1.0-linux-amd64`);
    expect(env!.PATH?.startsWith(BIN_DIR)).toBe(true);
  });

  test("getWrapperBinDir='/local/bin', getWrapperAgentBin=null → NEXUS_AGENT_BIN 미주입", async () => {
    const BIN_DIR = "/local/bin";
    const { handler, spawnedEnv } = makeFixtureWithManager({
      wrapperBinDir: BIN_DIR,
      wrapperAgentBin: null,
    });

    await handler({}, "pty", "spawn", spawnArgs());
    const env = spawnedEnv();

    expect(env).toBeDefined();
    expect(env!.NEXUS_WRAPPER_SELF_DIR).toBe(BIN_DIR);
    expect(env!.NEXUS_AGENT_BIN).toBeUndefined();
  });

  test("workspaceManager 없으면 → context 없이 env 주입(TERM_PROGRAM 기본값만)", async () => {
    const agentChannel = new FakeAgentChannel();
    let capturedEnv: Record<string, string> | undefined;
    const origCall = agentChannel.call.bind(agentChannel);
    agentChannel.call = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "pty.spawn") {
        capturedEnv = (params as { env?: Record<string, string> })?.env;
      }
      return origCall<T>(method, params);
    };

    const agentHost = startAgentPtyHost({
      getAgentChannel: async () => agentChannel,
      tryGetAgentChannel: async () => agentChannel,
    });
    // no workspaceManager
    registerPtyChannel({ agentHost });
    const handler = getIpcCallHandler();

    await handler({}, "pty", "spawn", spawnArgs());

    expect(capturedEnv).toBeDefined();
    // TERM_PROGRAM defaults are set even without workspaceManager
    expect(capturedEnv!.TERM_PROGRAM).toBe("ghostty");
    // wrapper env not injected
    expect(capturedEnv!.NEXUS_IN_APP).toBeUndefined();
  });
});
