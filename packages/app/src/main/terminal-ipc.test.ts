import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  TerminalExitedEvent,
  TerminalOpenCommand,
  TerminalStdoutChunk,
} from "../../../shared/src/contracts/terminal-ipc";
import type { TerminalCloseReason } from "../../../shared/src/contracts/terminal-lifecycle";
import type { TerminalTabId } from "../../../shared/src/contracts/terminal-tab";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import type {
  TerminalHostClearTimeout,
  TerminalHostCreateOptions,
  TerminalHostEnvironmentResolver,
  TerminalHostSetTimeout,
} from "./terminal-host";
import {
  DEFAULT_STDOUT_COALESCE_WINDOW_MS,
  MAX_STDOUT_COALESCE_WINDOW_MS,
  MIN_STDOUT_COALESCE_WINDOW_MS,
  TerminalMainIpcRouter,
  normalizeStdoutCoalesceWindowMs,
  type TerminalMainIpcAdapter,
  type TerminalMainIpcDisposable,
} from "./terminal-ipc";
import {
  WorkspaceTerminalRegistry,
  type WorkspaceTerminalHost,
  type WorkspaceTerminalHostFactory,
} from "./workspace-terminal-registry";
import { TerminalBridge, type TerminalBridgeTransport } from "../renderer/terminal-bridge";
import {
  OPENCODE_CONFIG_CONTENT_ENV,
  buildOpenCodeTerminalEnvOverrides,
} from "./opencode-runtime";

describe("TerminalMainIpcRouter + TerminalBridge", () => {
  test("routes terminal commands, coalesces stdout, and round-trips scrollback stats", async () => {
    const channel = new InMemoryTerminalIpcChannel();
    const hostFactory = new FakeHostFactory();
    const timerScheduler = new ManualTimerScheduler();
    const registry = new WorkspaceTerminalRegistry({ hostFactory });
    const router = new TerminalMainIpcRouter(
      {
        registry,
        shellEnvironmentResolver: TEST_ENVIRONMENT_RESOLVER,
        ipcAdapter: channel,
      },
      {
        createTabId: () => "tt_ws_alpha_ipc_001" as TerminalTabId,
        stdoutCoalesceWindowMs: DEFAULT_STDOUT_COALESCE_WINDOW_MS,
        setTimeoutFn: timerScheduler.setTimeout,
        clearTimeoutFn: timerScheduler.clearTimeout,
      },
    );
    router.start();

    const bridge = new TerminalBridge(channel);
    const receivedEvents: Array<{ type: string; payload: unknown }> = [];
    bridge.onEvent((event) => {
      receivedEvents.push({ type: event.type, payload: event });
    });

    const openCommand: TerminalOpenCommand = {
      type: "terminal/open",
      workspaceId: "ws_alpha",
      cols: 120,
      rows: 32,
      scrollbackMainBufferBytes: 6,
      scrollbackXtermLines: 99,
    };
    const opened = await bridge.open(openCommand);
    expect(opened).toEqual({
      type: "terminal/opened",
      tabId: "tt_ws_alpha_ipc_001",
      workspaceId: "ws_alpha",
      pid: 9001,
    });

    const host = hostFactory.byTabId.get(opened.tabId);
    expect(host).toBeDefined();
    expect(hostFactory.createCalls[0]?.cwd).toBeUndefined();

    await bridge.input({
      type: "terminal/input",
      tabId: opened.tabId,
      data: "echo hi\n",
    });
    await bridge.resize({
      type: "terminal/resize",
      tabId: opened.tabId,
      cols: 140,
      rows: 48,
    });

    expect(host?.writeCalls).toEqual(["echo hi\n"]);
    expect(host?.resizeCalls).toEqual([{ cols: 140, rows: 48 }]);

    host?.emitStdout("abcd");
    host?.emitStdout("efgh");

    const stdoutBeforeFlush = receivedEvents.filter((entry) => entry.type === "terminal/stdout");
    expect(stdoutBeforeFlush).toHaveLength(0);
    expect(timerScheduler.records).toHaveLength(1);
    expect(timerScheduler.records[0]?.delayMs).toBe(DEFAULT_STDOUT_COALESCE_WINDOW_MS);

    timerScheduler.fire(0);

    const stdoutAfterFlush = receivedEvents
      .filter((entry): entry is { type: "terminal/stdout"; payload: TerminalStdoutChunk } => {
        return entry.type === "terminal/stdout";
      })
      .map((entry) => entry.payload);
    expect(stdoutAfterFlush).toEqual([
      {
        type: "terminal/stdout",
        tabId: opened.tabId,
        seq: 0,
        data: "abcd",
      },
      {
        type: "terminal/stdout",
        tabId: opened.tabId,
        seq: 1,
        data: "efgh",
        mainBufferDroppedBytes: 2,
      },
    ]);

    const statsReply = await bridge.queryScrollbackStats({
      type: "terminal/scrollback-stats/query",
      tabId: opened.tabId,
    });
    expect(statsReply).toEqual({
      type: "terminal/scrollback-stats/reply",
      tabId: opened.tabId,
      mainBufferByteLimit: 6,
      mainBufferStoredBytes: 6,
      mainBufferDroppedBytesTotal: 2,
      xtermScrollbackLines: 99,
    });

    const closeReply = await bridge.close({
      type: "terminal/close",
      tabId: opened.tabId,
      reason: "user-close",
    });
    expect(closeReply).toEqual({
      type: "terminal/exited",
      tabId: opened.tabId,
      workspaceId: "ws_alpha",
      reason: "user-close",
      exitCode: 0,
    });
    expect(host?.closeCalls).toEqual(["user-close"]);

    const exitedEvents = receivedEvents.filter((entry) => entry.type === "terminal/exited");
    expect(exitedEvents).toHaveLength(1);

    bridge.dispose();
    router.stop();
  });

  test("rejects malformed and unknown terminal commands at the main IPC boundary", async () => {
    const channel = new InMemoryTerminalIpcChannel();
    const router = new TerminalMainIpcRouter({
      registry: new WorkspaceTerminalRegistry({ hostFactory: new FakeHostFactory() }),
      shellEnvironmentResolver: TEST_ENVIRONMENT_RESOLVER,
      ipcAdapter: channel,
    });
    router.start();

    await expect(
      channel.invoke({
        type: "terminal/unknown",
      }),
    ).rejects.toThrow("Invalid terminal IPC command payload.");

    await expect(
      channel.invoke({
        type: "terminal/input",
        tabId: "tt_ws_alpha_bad_001",
      }),
    ).rejects.toThrow("Invalid terminal IPC command payload.");

    router.stop();
  });

  test("resolves terminal cwd from the registered workspace when renderer omits cwd", async () => {
    const channel = new InMemoryTerminalIpcChannel();
    const hostFactory = new FakeHostFactory();
    const registry = new WorkspaceTerminalRegistry({ hostFactory });
    const router = new TerminalMainIpcRouter(
      {
        registry,
        shellEnvironmentResolver: TEST_ENVIRONMENT_RESOLVER,
        ipcAdapter: channel,
        resolveWorkspaceCwd: (workspaceId) => {
          if (workspaceId === "ws_alpha") {
            return "/Users/kih/workspaces/archives/opencode-nexus-test";
          }
          return null;
        },
      },
      {
        createTabId: () => "tt_ws_alpha_cwd_001" as TerminalTabId,
      },
    );
    router.start();

    const bridge = new TerminalBridge(channel);
    const opened = await bridge.open({
      type: "terminal/open",
      workspaceId: "ws_alpha",
      cols: 120,
      rows: 32,
    });

    expect(opened.workspaceId).toBe("ws_alpha");
    expect(hostFactory.createCalls[0]).toEqual({
      tabId: "tt_ws_alpha_cwd_001",
      workspaceId: "ws_alpha",
      cwd: "/Users/kih/workspaces/archives/opencode-nexus-test",
    });

    bridge.dispose();
    router.stop();
  });


  test("merges workspace env overrides into terminal open commands with command env taking precedence", async () => {
    const channel = new InMemoryTerminalIpcChannel();
    const hostFactory = new FakeHostFactory();
    const registry = new WorkspaceTerminalRegistry({ hostFactory });
    const router = new TerminalMainIpcRouter(
      {
        registry,
        shellEnvironmentResolver: TEST_ENVIRONMENT_RESOLVER,
        ipcAdapter: channel,
        resolveWorkspaceCwd: () => "/workspace/default",
        resolveWorkspaceEnvOverrides: (workspaceId) => ({
          ...buildOpenCodeTerminalEnvOverrides(workspaceId),
          SHARED_VALUE: "workspace",
        }),
      },
      {
        createTabId: () => "tt_ws_alpha_env_001" as TerminalTabId,
      },
    );
    router.start();

    const bridge = new TerminalBridge(channel);
    await bridge.open({
      type: "terminal/open",
      workspaceId: "ws_alpha" as WorkspaceId,
      cols: 120,
      rows: 32,
      envOverrides: {
        SHARED_VALUE: "command",
        USER_VALUE: "kept",
      },
    });

    expect(hostFactory.createCalls[0]?.envOverrides?.[OPENCODE_CONFIG_CONTENT_ENV]).toContain(
      '"server"',
    );
    expect(hostFactory.createCalls[0]?.envOverrides?.SHARED_VALUE).toBe("command");
    expect(hostFactory.createCalls[0]?.envOverrides?.USER_VALUE).toBe("kept");

    bridge.dispose();
    router.stop();
  });

  test("preserves an explicit terminal cwd when one is supplied", async () => {
    const channel = new InMemoryTerminalIpcChannel();
    const hostFactory = new FakeHostFactory();
    const registry = new WorkspaceTerminalRegistry({ hostFactory });
    const router = new TerminalMainIpcRouter(
      {
        registry,
        shellEnvironmentResolver: TEST_ENVIRONMENT_RESOLVER,
        ipcAdapter: channel,
        resolveWorkspaceCwd: () => "/workspace/default",
      },
      {
        createTabId: () => "tt_ws_alpha_explicit_cwd_001" as TerminalTabId,
      },
    );
    router.start();

    const bridge = new TerminalBridge(channel);
    await bridge.open({
      type: "terminal/open",
      workspaceId: "ws_alpha",
      cols: 120,
      rows: 32,
      cwd: "/tmp/explicit-terminal-cwd",
    });

    expect(hostFactory.createCalls[0]?.cwd).toBe("/tmp/explicit-terminal-cwd");

    bridge.dispose();
    router.stop();
  });

  test("rejects malformed terminal events at the renderer bridge boundary", () => {
    const channel = new InMemoryTerminalIpcChannel();
    const bridge = new TerminalBridge(channel);

    expect(() => {
      channel.emitEventPayload({
        type: "terminal/stdout",
        tabId: "tt_ws_alpha_guard_001",
        seq: -1,
        data: "broken",
      });
    }).toThrow("Invalid terminal IPC event payload.");

    bridge.dispose();
  });

  test("stdout coalescer window is constrained to 10–16ms", () => {
    expect(normalizeStdoutCoalesceWindowMs(undefined)).toBe(DEFAULT_STDOUT_COALESCE_WINDOW_MS);
    expect(normalizeStdoutCoalesceWindowMs(0)).toBe(MIN_STDOUT_COALESCE_WINDOW_MS);
    expect(normalizeStdoutCoalesceWindowMs(100)).toBe(MAX_STDOUT_COALESCE_WINDOW_MS);
  });

  test("terminal IPC wiring remains sidecar/harness independent", async () => {
    const mainDirectory = path.dirname(fileURLToPath(import.meta.url));
    const mainSource = await readFile(path.join(mainDirectory, "terminal-ipc.ts"), "utf8");
    const rendererSource = await readFile(
      path.join(mainDirectory, "../renderer/terminal-bridge.ts"),
      "utf8",
    );

    for (const source of [mainSource, rendererSource]) {
      expect(source).not.toMatch(/\bsidecar\b/i);
      expect(source).not.toMatch(/\bharness\b/i);
    }
  });
});

class InMemoryTerminalIpcChannel implements TerminalMainIpcAdapter, TerminalBridgeTransport {
  private commandHandler: ((payload: unknown) => Promise<unknown> | unknown) | null = null;
  private readonly eventListeners = new Set<(payload: unknown) => void>();

  public onCommand(
    handler: (payload: unknown) => Promise<unknown> | unknown,
  ): TerminalMainIpcDisposable {
    this.commandHandler = handler;
    return {
      dispose: () => {
        if (this.commandHandler === handler) {
          this.commandHandler = null;
        }
      },
    };
  }

  public sendEvent(payload: unknown): void {
    this.emitEventPayload(payload);
  }

  public async invoke(command: unknown): Promise<unknown> {
    if (!this.commandHandler) {
      throw new Error("No terminal command handler is registered.");
    }

    return this.commandHandler(command);
  }

  public onEvent(listener: (eventPayload: unknown) => void): TerminalMainIpcDisposable {
    this.eventListeners.add(listener);
    return {
      dispose: () => {
        this.eventListeners.delete(listener);
      },
    };
  }

  public emitEventPayload(payload: unknown): void {
    for (const listener of this.eventListeners) {
      listener(payload);
    }
  }
}

class FakeHostFactory implements WorkspaceTerminalHostFactory {
  public readonly createCalls: MainHostCreateCall[] = [];
  public readonly byTabId = new Map<TerminalTabId, FakeTerminalHost>();

  public async create(options: TerminalHostCreateOptions): Promise<WorkspaceTerminalHost> {
    const createCall: MainHostCreateCall = {
      tabId: options.tabId,
      workspaceId: options.openCommand.workspaceId,
      cwd: options.openCommand.cwd,
    };
    if (options.openCommand.envOverrides) {
      createCall.envOverrides = options.openCommand.envOverrides;
    }
    this.createCalls.push(createCall);

    const host = new FakeTerminalHost({
      tabId: options.tabId,
      workspaceId: options.openCommand.workspaceId,
      pid: 9000 + this.createCalls.length,
    });
    this.byTabId.set(host.tabId, host);
    return host;
  }
}

type MainHostCreateCall = {
  tabId: TerminalTabId;
  workspaceId: WorkspaceId;
  cwd?: string;
  envOverrides?: Record<string, string>;
};

class FakeTerminalHost implements WorkspaceTerminalHost {
  public readonly closeCalls: TerminalCloseReason[] = [];
  public readonly writeCalls: string[] = [];
  public readonly resizeCalls: Array<{ cols: number; rows: number }> = [];

  private readonly stdoutListeners = new Set<(chunk: TerminalStdoutChunk) => void>();
  private readonly exitListeners = new Set<(event: TerminalExitedEvent) => void>();
  private seq = 0;
  private exitEvent: TerminalExitedEvent | null = null;

  public readonly tabId: TerminalTabId;
  public readonly workspaceId: WorkspaceId;
  private readonly pid: number;

  public constructor(options: { tabId: TerminalTabId; workspaceId: WorkspaceId; pid: number }) {
    this.tabId = options.tabId;
    this.workspaceId = options.workspaceId;
    this.pid = options.pid;
  }

  public toOpenedEvent() {
    return {
      type: "terminal/opened" as const,
      tabId: this.tabId,
      workspaceId: this.workspaceId,
      pid: this.pid,
    };
  }

  public write(data: string): void {
    this.writeCalls.push(data);
  }

  public resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  public async close(reason: TerminalCloseReason): Promise<TerminalExitedEvent> {
    this.closeCalls.push(reason);

    if (this.exitEvent) {
      return this.exitEvent;
    }

    const event: TerminalExitedEvent = {
      type: "terminal/exited",
      tabId: this.tabId,
      workspaceId: this.workspaceId,
      reason,
      exitCode: 0,
    };
    this.emitExit(event);
    return event;
  }

  public onStdout(listener: (chunk: TerminalStdoutChunk) => void): { dispose(): void } {
    this.stdoutListeners.add(listener);
    return {
      dispose: () => {
        this.stdoutListeners.delete(listener);
      },
    };
  }

  public onExit(listener: (event: TerminalExitedEvent) => void): { dispose(): void } {
    if (this.exitEvent) {
      listener(this.exitEvent);
      return {
        dispose: () => undefined,
      };
    }

    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      },
    };
  }

  public emitStdout(data: string): void {
    const chunk: TerminalStdoutChunk = {
      type: "terminal/stdout",
      tabId: this.tabId,
      seq: this.seq,
      data,
    };
    this.seq += 1;

    for (const listener of this.stdoutListeners) {
      listener(chunk);
    }
  }

  private emitExit(event: TerminalExitedEvent): void {
    if (this.exitEvent) {
      return;
    }

    this.exitEvent = event;
    for (const listener of Array.from(this.exitListeners)) {
      listener(event);
    }
    this.exitListeners.clear();
  }
}

const TEST_ENVIRONMENT_RESOLVER: TerminalHostEnvironmentResolver = {
  async getBaseEnv() {
    return {
      PATH: "/usr/bin:/bin",
      TERM: "xterm-256color",
    };
  },
  getDefaultShell() {
    return "/bin/zsh";
  },
  getDefaultShellArgs() {
    return ["-l", "-i"];
  },
};

type ManualTimerRecord = {
  delayMs: number;
  callback: () => void;
  cleared: boolean;
  unrefCalled: boolean;
  handle: ManualTimerHandle;
};

type ManualTimerHandle = {
  id: number;
  unref: () => void;
};

class ManualTimerScheduler {
  public readonly records: ManualTimerRecord[] = [];
  private nextId = 1;

  public readonly setTimeout: TerminalHostSetTimeout = (callback, delayMs) => {
    const handle: ManualTimerHandle = {
      id: this.nextId,
      unref: () => {
        const record = this.records.find((entry) => entry.handle.id === handle.id);
        if (record) {
          record.unrefCalled = true;
        }
      },
    };
    this.nextId += 1;

    const record: ManualTimerRecord = {
      delayMs,
      callback,
      cleared: false,
      unrefCalled: false,
      handle,
    };
    this.records.push(record);
    return handle as unknown as ReturnType<typeof setTimeout>;
  };

  public readonly clearTimeout: TerminalHostClearTimeout = (timeoutHandle) => {
    const handle = timeoutHandle as unknown as ManualTimerHandle;
    const record = this.records.find((entry) => entry.handle.id === handle.id);
    if (record) {
      record.cleared = true;
    }
  };

  public fire(index: number): void {
    const record = this.records[index];
    if (!record || record.cleared) {
      return;
    }

    record.callback();
  }
}
