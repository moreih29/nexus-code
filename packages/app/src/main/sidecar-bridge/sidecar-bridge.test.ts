import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";

import type {
  LspServerPayloadMessage,
  LspStartServerCommand,
} from "../../../../shared/src/contracts/lsp/lsp-sidecar";
import type { SidecarStartCommand } from "../../../../shared/src/contracts/sidecar/sidecar";
import type { TabBadgeEvent, ToolCallEvent } from "../../../../shared/src/contracts/harness/harness-observer";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { SidecarBridge, SidecarBridgeError } from "./index";
import { SidecarLifecycleEmitter } from "./lifecycle-emitter";

const workspaceId = "ws_bridge_test" as WorkspaceId;
const startCommand: SidecarStartCommand = {
  type: "sidecar/start",
  workspaceId,
  workspacePath: "/tmp/nexus-bridge-test",
  reason: "workspace-open",
};

const openServers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) {
            client.terminate();
          }
          const timer = setTimeout(resolve, 10);
          server.close(() => {
            clearTimeout(timer);
            resolve();
          });
        }),
    ),
  );
});

describe("SidecarBridge", () => {
  test("정상 spawn → READY → WS → Start/Started → Stop/Stopped → exit 흐름을 수행한다", async () => {
    const child = new MockChildProcess(4312);
    const bridge = new SidecarBridge({
      sidecarBin: "/mock/nexus-sidecar",
      existsSyncFn: () => true,
      spawnProcess: createMockSpawn(child, { mode: "normal" }),
      reconcileWindowMs: 5,
      stopAckTimeoutMs: 20,
      stopSigkillTimeoutMs: 20,
    });

    const started = await bridge.start(startCommand);
    expect(started).toMatchObject({
      type: "sidecar/started",
      workspaceId,
      pid: 4312,
    });

    const stopped = await bridge.stop({
      type: "sidecar/stop",
      workspaceId,
      reason: "workspace-close",
    });
    expect(stopped).toMatchObject({
      type: "sidecar/stopped",
      workspaceId,
      reason: "requested",
      exitCode: 0,
    });
    expect(child.killCalls).toEqual([]);
    expect(bridge.listRunningWorkspaceIds()).toEqual([]);
  });

  test("sidecar-sent harness/tab-badge messages emit observer events", async () => {
    const child = new MockChildProcess(4320);
    const bridge = new SidecarBridge({
      sidecarBin: "/mock/nexus-sidecar",
      existsSyncFn: () => true,
      spawnProcess: createMockSpawn(child, { mode: "normal" }),
      reconcileWindowMs: 5,
      stopAckTimeoutMs: 20,
      stopSigkillTimeoutMs: 20,
    });
    const tabBadgeEvent: TabBadgeEvent = {
      type: "harness/tab-badge",
      workspaceId,
      adapterName: "claude-code",
      sessionId: "sess_bridge_001",
      state: "awaiting-approval",
      timestamp: "2026-04-26T05:15:00.000Z",
    };
    let subscription: ReturnType<SidecarBridge["onObserverEvent"]> | null = null;
    const observerEventPromise = new Promise<TabBadgeEvent>((resolve) => {
      subscription = bridge.onObserverEvent((event) => {
        subscription?.dispose();
        resolve(event as TabBadgeEvent);
      });
    });

    try {
      await bridge.start(startCommand);

      const serverClient = Array.from(openServers.at(-1)?.clients ?? [])[0];
      expect(serverClient).toBeDefined();
      serverClient?.send(JSON.stringify(tabBadgeEvent));

      await expect(observerEventPromise).resolves.toEqual(tabBadgeEvent);
    } finally {
      subscription?.dispose();
      await bridge
        .stop({
          type: "sidecar/stop",
          workspaceId,
          reason: "workspace-close",
        })
        .catch(() => null);
    }
  });

  test("sidecar-sent harness/tool-call messages emit observer events", async () => {
    const child = new MockChildProcess(4321);
    const bridge = new SidecarBridge({
      sidecarBin: "/mock/nexus-sidecar",
      existsSyncFn: () => true,
      spawnProcess: createMockSpawn(child, { mode: "normal" }),
      reconcileWindowMs: 5,
      stopAckTimeoutMs: 20,
      stopSigkillTimeoutMs: 20,
    });
    const toolCallEvent: ToolCallEvent = {
      type: "harness/tool-call",
      workspaceId,
      adapterName: "claude-code",
      sessionId: "sess_bridge_002",
      status: "started",
      toolName: "Read",
      timestamp: "2026-04-26T05:15:01.000Z",
      inputSummary: "file_path: hello.py",
    };
    let subscription: ReturnType<SidecarBridge["onObserverEvent"]> | null = null;
    const observerEventPromise = new Promise<ToolCallEvent>((resolve) => {
      subscription = bridge.onObserverEvent((event) => {
        subscription?.dispose();
        resolve(event as ToolCallEvent);
      });
    });

    try {
      await bridge.start(startCommand);

      const serverClient = Array.from(openServers.at(-1)?.clients ?? [])[0];
      expect(serverClient).toBeDefined();
      serverClient?.send(JSON.stringify(toolCallEvent));

      await expect(observerEventPromise).resolves.toEqual(toolCallEvent);
    } finally {
      subscription?.dispose();
      await bridge
        .stop({
          type: "sidecar/stop",
          workspaceId,
          reason: "workspace-close",
        })
        .catch(() => null);
    }
  });

  test("토큰 불일치 401은 재시도 없이 fatal 처리한다", async () => {
    const children: MockChildProcess[] = [];
    const bridge = new SidecarBridge({
      sidecarBin: "/mock/nexus-sidecar",
      existsSyncFn: () => true,
      spawnProcess: ((bin: string, args: readonly string[], options: SpawnOptions) => {
        const child = new MockChildProcess(4400 + children.length);
        children.push(child);
        return createMockSpawn(child, { mode: "token-mismatch" })(bin, args, options);
      }) as typeof import("node:child_process").spawn,
      wsTimeoutMs: 100,
    });

    await expect(bridge.start(startCommand)).rejects.toMatchObject({
      kind: "fatal",
      code: "WS_401",
    } satisfies Partial<SidecarBridgeError>);
    expect(children).toHaveLength(1);
  });


  test("LSP lifecycle requests and relay payloads use the sidecar WebSocket", async () => {
    const child = new MockChildProcess(4335);
    const bridge = new SidecarBridge({
      sidecarBin: "/mock/nexus-sidecar",
      existsSyncFn: () => true,
      spawnProcess: createMockSpawn(child, { mode: "normal" }),
      reconcileWindowMs: 5,
      stopAckTimeoutMs: 20,
      stopSigkillTimeoutMs: 20,
      startedTimeoutMs: 100,
    });
    const lspStartCommand: LspStartServerCommand = {
      type: "lsp/lifecycle",
      action: "start_server",
      requestId: "req_lsp_start",
      workspaceId,
      serverId: `${workspaceId}:typescript`,
      language: "typescript",
      command: "typescript-language-server",
      args: ["--stdio"],
      cwd: "/tmp/nexus-bridge-test",
      serverName: "typescript-language-server",
    };
    const relayPayload = "Content-Length: 2\r\n\r\n{}";
    let subscription: ReturnType<SidecarBridge["onServerPayload"]> | null = null;
    const relayPromise = new Promise<LspServerPayloadMessage>((resolve) => {
      subscription = bridge.onServerPayload((message) => {
        subscription?.dispose();
        resolve(message);
      });
    });

    try {
      await bridge.start(startCommand);

      await expect(bridge.startServer(lspStartCommand)).resolves.toMatchObject({
        type: "lsp/lifecycle",
        action: "server_started",
        requestId: "req_lsp_start",
        workspaceId,
        serverId: `${workspaceId}:typescript`,
      });

      bridge.sendClientPayload({
        type: "lsp/relay",
        direction: "client_to_server",
        workspaceId,
        serverId: `${workspaceId}:typescript`,
        seq: 1,
        payload: relayPayload,
      });

      await expect(relayPromise).resolves.toMatchObject({
        type: "lsp/relay",
        direction: "server_to_client",
        workspaceId,
        serverId: `${workspaceId}:typescript`,
        payload: relayPayload,
      });

      await expect(
        bridge.stopAllServers({
          type: "lsp/lifecycle",
          action: "stop_all",
          requestId: "req_lsp_stop_all",
          workspaceId,
          reason: "app-shutdown",
        }),
      ).resolves.toMatchObject({
        type: "lsp/lifecycle",
        action: "stop_all_stopped",
        requestId: "req_lsp_stop_all",
        workspaceId,
        stoppedServerIds: [`${workspaceId}:typescript`],
      });
    } finally {
      subscription?.dispose();
      await bridge
        .stop({
          type: "sidecar/stop",
          workspaceId,
          reason: "workspace-close",
        })
        .catch(() => null);
    }
  });

  test("dataDir option is passed to sidecar server mode for hook listener startup", async () => {
    const child = new MockChildProcess(4330);
    const spawnArgs: readonly string[][] = [];
    const bridge = new SidecarBridge({
      sidecarBin: "/mock/nexus-sidecar",
      dataDir: "/tmp/nexus-user-data",
      existsSyncFn: () => true,
      spawnProcess: ((bin: string, args: readonly string[], options: SpawnOptions) => {
        spawnArgs.push([...args]);
        return createMockSpawn(child, { mode: "normal" })(bin, args, options);
      }) as typeof import("node:child_process").spawn,
      reconcileWindowMs: 5,
      stopAckTimeoutMs: 20,
      stopSigkillTimeoutMs: 20,
    });

    try {
      await bridge.start(startCommand);

      expect(spawnArgs[0]).toEqual([
        `--workspace-id=${workspaceId}`,
        "--data-dir=/tmp/nexus-user-data",
      ]);
    } finally {
      await bridge
        .stop({
          type: "sidecar/stop",
          workspaceId,
          reason: "workspace-close",
        })
        .catch(() => null);
    }
  });

  test("SIGKILL 종료는 process-crash로 합성한다", async () => {
    const emitter = new SidecarLifecycleEmitter({ workspaceId, reconcileWindowMs: 5 });
    const stoppedPromise = emitter.waitForStopped();

    emitter.recordProcessExit(null, "SIGKILL");

    await expect(stoppedPromise).resolves.toMatchObject({
      type: "sidecar/stopped",
      workspaceId,
      reason: "process-crash",
      exitCode: null,
    });
  });

  test("expectedCloseCodes에 포함된 close code를 requested로 합성한다", async () => {
    const child = new MockChildProcess(4510);
    const bridge = new SidecarBridge({
      sidecarBin: "/mock/nexus-sidecar",
      existsSyncFn: () => true,
      spawnProcess: createMockSpawn(child, { mode: "normal", stopCloseCode: 4000 }),
      expectedCloseCodes: [4000],
      reconcileWindowMs: 5,
      stopAckTimeoutMs: 20,
      stopSigkillTimeoutMs: 20,
    });

    await bridge.start(startCommand);
    const stopped = await bridge.stop({
      type: "sidecar/stop",
      workspaceId,
      reason: "workspace-close",
    });

    expect(stopped).toMatchObject({
      type: "sidecar/stopped",
      workspaceId,
      reason: "requested",
      exitCode: 0,
    });
    expect(child.killCalls).toEqual([]);
  });

  test("sidecar binary가 없으면 spawn하지 않고 unavailable started event를 반환한다", async () => {
    const bridge = new SidecarBridge({
      sidecarBin: "/missing/nexus-sidecar",
      existsSyncFn: () => false,
      spawnProcess: (() => {
        throw new Error("spawn should not be called");
      }) as typeof import("node:child_process").spawn,
      now: () => new Date("2026-04-25T00:00:00.000Z"),
    });

    const started = await bridge.start(startCommand);

    expect(started).toEqual({
      type: "sidecar/started",
      workspaceId,
      pid: -1,
      startedAt: "2026-04-25T00:00:00.000Z",
    });
    expect(bridge.listRunningWorkspaceIds()).toEqual([]);
    await expect(
      bridge.stop({
        type: "sidecar/stop",
        workspaceId,
        reason: "workspace-close",
      }),
    ).resolves.toBeNull();
  });

  test("dedupe gate는 WS close와 exit가 1초 창 안에 도착해도 1회만 emit한다", async () => {
    const emitter = new SidecarLifecycleEmitter({ workspaceId, reconcileWindowMs: 20 });
    const events: unknown[] = [];
    emitter.on("stopped", (event) => events.push(event));

    emitter.recordWsClose(1000, true);
    emitter.recordProcessExit(0, null);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: "requested", exitCode: 0 });
  });

  test("heartbeat 2회 실패 시 ws.terminate()와 child.kill('SIGTERM')을 호출한다", async () => {
    const originalPing = WebSocket.prototype.ping;
    WebSocket.prototype.ping = function patchedPing(
      this: WebSocket,
      data?: unknown,
      mask?: boolean,
      callback?: (err?: Error) => void,
    ): void {
      if (typeof callback === "function") {
        callback();
      }
    } as typeof WebSocket.prototype.ping;

    try {
      const child = new MockChildProcess(4500);
      const bridge = new SidecarBridge({
        sidecarBin: "/mock/nexus-sidecar",
        existsSyncFn: () => true,
        spawnProcess: createMockSpawn(child, { mode: "normal" }),
        heartbeatIntervalMs: 5,
        heartbeatTimeoutMs: 1,
        reconcileWindowMs: 5,
      });

      await bridge.start(startCommand);
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(child.killCalls).toContain("SIGTERM");
    } finally {
      WebSocket.prototype.ping = originalPing;
    }
  });
});

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

type MockMode = "normal" | "token-mismatch";

function createMockSpawn(
  child: MockChildProcess,
  options: { mode: MockMode; stopCloseCode?: number },
): typeof import("node:child_process").spawn {
  return ((_sidecarBin: string, _args: readonly string[], spawnOptions: SpawnOptions) => {
    const expectedToken =
      options.mode === "token-mismatch"
        ? "definitely-not-the-generated-token"
        : String(spawnOptions.env?.NEXUS_SIDECAR_TOKEN);
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
        const message = JSON.parse(data.toString()) as Record<string, any>;
        if (message.type === "sidecar/start") {
          ws.send(
            JSON.stringify({
              type: "sidecar/started",
              workspaceId,
              pid: child.pid,
              startedAt: new Date("2026-04-25T00:00:00.000Z").toISOString(),
            }),
          );
        }
        if (message.type === "lsp/lifecycle" && message.action === "start_server") {
          ws.send(
            JSON.stringify({
              type: "lsp/lifecycle",
              action: "server_started",
              requestId: message.requestId,
              workspaceId,
              serverId: message.serverId,
              language: message.language,
              serverName: message.serverName,
              pid: child.pid + 100,
            }),
          );
        }
        if (message.type === "lsp/lifecycle" && message.action === "stop_all") {
          ws.send(
            JSON.stringify({
              type: "lsp/lifecycle",
              action: "stop_all_stopped",
              requestId: message.requestId,
              workspaceId,
              stoppedServerIds: [`${workspaceId}:typescript`],
            }),
          );
        }
        if (message.type === "lsp/relay" && message.direction === "client_to_server") {
          ws.send(
            JSON.stringify({
              type: "lsp/relay",
              direction: "server_to_client",
              workspaceId,
              serverId: message.serverId,
              seq: message.seq,
              payload: message.payload,
            }),
          );
        }
        if (message.type === "sidecar/stop") {
          ws.send(
            JSON.stringify({
              type: "sidecar/stopped",
              workspaceId,
              reason: "requested",
              stoppedAt: new Date("2026-04-25T00:00:01.000Z").toISOString(),
              exitCode: 0,
            }),
          );
          ws.close(options.stopCloseCode ?? 1000);
          child.emit("exit", 0, null);
        }
      });
    });

    return child as unknown as ChildProcess;
  }) as typeof import("node:child_process").spawn;
}
