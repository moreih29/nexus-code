import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { BrowserWindow } from "electron";
import { WebSocketServer } from "ws";

import { HARNESS_OBSERVER_EVENT_CHANNEL } from "../../../shared/src/contracts/ipc-channels";
import type { SidecarStartCommand } from "../../../shared/src/contracts/sidecar";
import type {
  HarnessObserverEvent,
  TabBadgeEvent,
  ToolCallEvent,
} from "../../../shared/src/contracts/harness-observer";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace";

const tempDirs: string[] = [];
const ipcMain = {
  handle: mock(() => undefined),
  removeHandler: mock(() => undefined),
};
const originalResourcesPath = process.resourcesPath;
const openServers: WebSocketServer[] = [];

mock.module("electron", () => ({
  app: {
    getPath: () => tempDirs[0] ?? os.tmpdir(),
    getAppPath: () => path.join(tempDirs[0] ?? os.tmpdir(), "packages", "app"),
    isPackaged: false,
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  ipcMain,
  Notification: Object.assign(
    function Notification(payload: unknown) {
      return { payload, show: () => undefined };
    },
    { isSupported: () => true },
  ),
}));

afterEach(async () => {
  ipcMain.handle.mockClear();
  ipcMain.removeHandler.mockClear();
  Object.defineProperty(process, "resourcesPath", {
    value: originalResourcesPath,
    configurable: true,
  });

  await Promise.all([
    ...openServers.splice(0).map(closeServer),
    ...tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })),
  ]);
});

describe("composeElectronAppServices", () => {
  test("SidecarBridge를 SidecarRuntime으로 주입한다", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "nexus-composition-"));
    tempDirs.push(tempDir);
    Object.defineProperty(process, "resourcesPath", {
      value: path.join(tempDir, "resources"),
      configurable: true,
    });

    const { composeElectronAppServices } = await import("./electron-app-composition");
    const { SidecarBridge } = await import("./sidecar-bridge");
    const mainWindow = createMainWindowMock();

    const services = await composeElectronAppServices(mainWindow);

    try {
      expect(services.sidecarRuntime).toBeInstanceOf(SidecarBridge);
      expect(
        (services.sidecarRuntime as unknown as { options: { dataDir?: string } }).options.dataDir,
      ).toBe(tempDir);
      expect(services.harnessAdapters.map((adapter) => adapter.describe().name)).toEqual([
        "claude-code",
        "opencode",
        "codex",
      ]);
    } finally {
      await services.dispose();
    }
  });

  test("SidecarBridge observer stream feeds the ClaudeCodeAdapter dispatch path", async () => {
    const { createSidecarObserverEventStream } = await import("./electron-app-composition");
    const { ClaudeCodeAdapter } = await import("../../../shared/src/harness/adapters/claude-code");
    const workspaceId = "ws_adapter_dispatch" as WorkspaceId;
    const source = new FakeSidecarObserverEventSource();
    const adapter = new ClaudeCodeAdapter({
      eventStream: (_workspaceId, signal) =>
        createSidecarObserverEventStream(source, signal, workspaceId),
    });
    const iterator = adapter.observe(workspaceId)[Symbol.asyncIterator]();
    const nextEvent = iterator.next();
    const tabBadgeEvent: TabBadgeEvent = {
      type: "harness/tab-badge",
      workspaceId,
      adapterName: "claude-code",
      sessionId: "sess_adapter_dispatch",
      state: "running",
      timestamp: "2026-04-26T05:15:00.000Z",
    };

    source.emit(tabBadgeEvent);

    await expect(nextEvent).resolves.toEqual({
      done: false,
      value: tabBadgeEvent,
    });
    adapter.dispose();
    await iterator.return?.();
  });

  test("SidecarBridge observer stream feeds opencode and codex adapter dispatch paths", async () => {
    const { createSidecarObserverEventStream } = await import("./electron-app-composition");
    const { CodexAdapter } = await import("../../../shared/src/harness/adapters/codex");
    const { OpenCodeAdapter } = await import("../../../shared/src/harness/adapters/opencode");
    const workspaceId = "ws_adapter_parity" as WorkspaceId;
    const source = new FakeSidecarObserverEventSource();
    const opencodeAdapter = new OpenCodeAdapter({
      eventStream: (_workspaceId, signal) =>
        createSidecarObserverEventStream(source, signal, workspaceId),
    });
    const codexAdapter = new CodexAdapter({
      eventStream: (_workspaceId, signal) =>
        createSidecarObserverEventStream(source, signal, workspaceId),
    });
    const opencodeIterator = opencodeAdapter.observe(workspaceId)[Symbol.asyncIterator]();
    const codexIterator = codexAdapter.observe(workspaceId)[Symbol.asyncIterator]();
    const nextOpenCodeEvent = opencodeIterator.next();
    const nextCodexEvent = codexIterator.next();
    const opencodeEvent: ToolCallEvent = {
      type: "harness/tool-call",
      workspaceId,
      adapterName: "opencode",
      sessionId: "sess_opencode_dispatch",
      status: "started",
      toolName: "bash",
      timestamp: "2026-04-26T05:15:00.000Z",
    };
    const codexEvent: TabBadgeEvent = {
      type: "harness/tab-badge",
      workspaceId,
      adapterName: "codex",
      sessionId: "sess_codex_dispatch",
      state: "running",
      timestamp: "2026-04-26T05:15:00.001Z",
    };

    source.emit(opencodeEvent);
    source.emit(codexEvent);

    await expect(nextOpenCodeEvent).resolves.toEqual({
      done: false,
      value: opencodeEvent,
    });
    await expect(nextCodexEvent).resolves.toEqual({
      done: false,
      value: codexEvent,
    });
    opencodeAdapter.dispose();
    codexAdapter.dispose();
    await opencodeIterator.return?.();
    await codexIterator.return?.();
  });



  test("SidecarBridge observer events also flow to notification sink", async () => {
    const { subscribeSidecarObserverEvents } = await import("./electron-app-composition");
    const workspaceId = "ws_notify" as WorkspaceId;
    const source = new FakeSidecarObserverEventSource();
    const mainWindow = createMainWindowMock();
    const notified: HarnessObserverEvent[] = [];
    const subscription = subscribeSidecarObserverEvents(source, mainWindow, {
      handleObserverEvent: (event) => notified.push(event),
    });
    const event: TabBadgeEvent = {
      type: "harness/tab-badge",
      workspaceId,
      adapterName: "claude-code",
      sessionId: "sess_notify",
      state: "completed",
      timestamp: "2026-04-26T05:15:00.000Z",
    };

    try {
      source.emit(event);

      expect(notified).toEqual([event]);
      expect(getWebContentsSendCalls(mainWindow)).toEqual([
        {
          channel: HARNESS_OBSERVER_EVENT_CHANNEL,
          payload: event,
        },
      ]);
    } finally {
      subscription.dispose();
    }
  });

  test("SidecarBridge observer events traverse to renderer IPC", async () => {
    const { SidecarBridge } = await import("./sidecar-bridge");
    const { subscribeSidecarObserverEvents } = await import("./electron-app-composition");
    const workspaceId = "ws_composition_observer" as WorkspaceId;
    const startCommand: SidecarStartCommand = {
      type: "sidecar/start",
      workspaceId,
      workspacePath: "/tmp/nexus-composition-observer",
      reason: "workspace-open",
    };
    const tabBadgeEvent: TabBadgeEvent = {
      type: "harness/tab-badge",
      workspaceId,
      adapterName: "claude-code",
      sessionId: "sess_composition_001",
      state: "awaiting-approval",
      timestamp: "2026-04-26T05:15:00.000Z",
    };
    const toolCallEvent: ToolCallEvent = {
      type: "harness/tool-call",
      workspaceId,
      adapterName: "claude-code",
      sessionId: "sess_composition_001",
      status: "awaiting-approval",
      toolName: "Permission",
      timestamp: "2026-04-26T05:15:00.001Z",
      message: "Claude needs permission",
    };
    const child = new MockChildProcess(5300);
    const bridge = new SidecarBridge({
      sidecarBin: "/mock/nexus-sidecar",
      existsSyncFn: () => true,
      spawnProcess: createMockSpawn(child, { workspaceId }),
      reconcileWindowMs: 5,
      stopAckTimeoutMs: 20,
      stopSigkillTimeoutMs: 20,
    });
    const mainWindow = createMainWindowMock();
    const subscription = subscribeSidecarObserverEvents(bridge, mainWindow);

    try {
      await bridge.start(startCommand);

      const serverClient = Array.from(openServers.at(-1)?.clients ?? [])[0];
      expect(serverClient).toBeDefined();
      serverClient?.send(JSON.stringify(tabBadgeEvent));
      serverClient?.send(JSON.stringify(toolCallEvent));

      await waitFor(() => {
        expect(getWebContentsSendCalls(mainWindow)).toEqual([
          {
            channel: HARNESS_OBSERVER_EVENT_CHANNEL,
            payload: tabBadgeEvent,
          },
          {
            channel: HARNESS_OBSERVER_EVENT_CHANNEL,
            payload: toolCallEvent,
          },
        ]);
      });
    } finally {
      subscription.dispose();
      await bridge
        .stop({
          type: "sidecar/stop",
          workspaceId,
          reason: "workspace-close",
        })
        .catch(() => null);
    }
  });
});

function createMainWindowMock(): BrowserWindow {
  const sendCalls: Array<{ channel: string; payload: unknown }> = [];
  const webContents = {
    send: mock((channel: string, payload: unknown) => {
      sendCalls.push({ channel, payload });
    }),
    on: mock(() => undefined),
    off: mock(() => undefined),
    isDestroyed: () => false,
    sendCalls,
  };

  return {
    webContents,
    isDestroyed: () => false,
  } as unknown as BrowserWindow;
}

function getWebContentsSendCalls(
  mainWindow: BrowserWindow,
): Array<{ channel: string; payload: unknown }> {
  return (
    mainWindow.webContents as unknown as {
      sendCalls: Array<{ channel: string; payload: unknown }>;
    }
  ).sendCalls;
}

class FakeSidecarObserverEventSource {
  private readonly listeners = new Set<(event: HarnessObserverEvent) => void>();

  onObserverEvent(listener: (event: HarnessObserverEvent) => void) {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  emit(event: HarnessObserverEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class MockChildProcess extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly stdin = null;
  public readonly killCalls: NodeJS.Signals[] = [];
  public killed = false;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;

  public constructor(public readonly pid: number) {
    super();
  }

  public kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killCalls.push(signal);
    this.killed = true;
    return true;
  }
}

function createMockSpawn(
  child: MockChildProcess,
  options: { workspaceId: WorkspaceId },
): typeof import("node:child_process").spawn {
  return ((_sidecarBin: string, _args: readonly string[], spawnOptions: SpawnOptions) => {
    const expectedToken = String(spawnOptions.env?.NEXUS_SIDECAR_TOKEN);
    const server = new WebSocketServer({
      port: 0,
      handleProtocols: (protocols) =>
        protocols.has("nexus.sidecar.v1") ? "nexus.sidecar.v1" : false,
      verifyClient: (info, done) => {
        done(info.req.headers["x-sidecar-token"] === expectedToken, 401);
      },
    });
    openServers.push(server);

    server.on("listening", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        child.stdout.write(
          `NEXUS_SIDECAR_READY port=${address.port} pid=${child.pid} proto=ws v=1\n`,
        );
      }
    });
    server.on("connection", (ws) => {
      ws.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === "sidecar/start") {
          ws.send(
            JSON.stringify({
              type: "sidecar/started",
              workspaceId: options.workspaceId,
              pid: child.pid,
              startedAt: new Date("2026-04-25T00:00:00.000Z").toISOString(),
            }),
          );
        }
        if (message.type === "sidecar/stop") {
          ws.send(
            JSON.stringify({
              type: "sidecar/stopped",
              workspaceId: options.workspaceId,
              reason: "requested",
              stoppedAt: new Date("2026-04-25T00:00:01.000Z").toISOString(),
              exitCode: 0,
            }),
          );
          ws.close(1000);
          child.emit("exit", 0, null);
        }
      });
    });

    return child as unknown as ChildProcess;
  }) as typeof import("node:child_process").spawn;
}

async function closeServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve) => {
    for (const client of server.clients) {
      client.terminate();
    }
    const timer = setTimeout(resolve, 10);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitFor(assertion: () => void, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Timed out waiting for assertion.");
}
