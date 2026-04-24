import { describe, expect, test } from "bun:test";

import type {
  TerminalExitedEvent,
  TerminalOpenCommand,
  TerminalStdoutChunk,
} from "../../../shared/src/contracts/terminal-ipc";
import type { TerminalTabId } from "../../../shared/src/contracts/terminal-tab";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import type { TerminalHostCreateOptions, TerminalHostEnvironmentResolver } from "./terminal-host";
import {
  DEFAULT_MAIN_BUFFER_BYTE_LIMIT,
  DEFAULT_XTERM_SCROLLBACK_LINES,
  WorkspaceTerminalRegistry,
  type WorkspaceTerminalHost,
  type WorkspaceTerminalHostFactory,
} from "./workspace-terminal-registry";

describe("WorkspaceTerminalRegistry", () => {
  test("openTerminal/register flow keeps stable insertion order per workspace", async () => {
    const hostFactory = new FakeHostFactory();
    const registry = new WorkspaceTerminalRegistry({ hostFactory });

    const alphaTabA = "tt_ws_alpha_001" as TerminalTabId;
    const alphaTabB = "tt_ws_alpha_002" as TerminalTabId;
    const betaTab = "tt_ws_beta_001" as TerminalTabId;

    const openedAlphaA = await registry.openTerminal(createHostOptions(alphaTabA, "ws_alpha"));
    const openedAlphaB = await registry.openTerminal(createHostOptions(alphaTabB, "ws_alpha"));
    const openedBeta = await registry.openTerminal(createHostOptions(betaTab, "ws_beta"));

    expect(openedAlphaA).toMatchObject({ tabId: alphaTabA, workspaceId: "ws_alpha" });
    expect(openedAlphaB).toMatchObject({ tabId: alphaTabB, workspaceId: "ws_alpha" });
    expect(openedBeta).toMatchObject({ tabId: betaTab, workspaceId: "ws_beta" });

    expect(registry.listTabIdsForWorkspace("ws_alpha")).toEqual([alphaTabA, alphaTabB]);
    expect(registry.listTabIdsForWorkspace("ws_beta")).toEqual([betaTab]);
    expect(hostFactory.createCalls).toHaveLength(3);
  });

  test("tracks per-tab byte-capped ring buffer stats and annotates dropped chunk bytes", () => {
    const tabId = "tt_ws_alpha_overflow" as TerminalTabId;
    const host = new FakeTerminalHost({
      tabId,
      workspaceId: "ws_alpha",
      pid: 4101,
    });
    const registry = new WorkspaceTerminalRegistry({
      defaultMainBufferByteLimit: 8,
      defaultXtermScrollbackLines: 77,
    });

    const stdoutEvents: TerminalStdoutChunk[] = [];
    registry.onStdout((chunk) => {
      stdoutEvents.push(chunk);
    });

    registry.registerHost(host);

    host.emitStdout("abcd");
    host.emitStdout("efgh");
    host.emitStdout("ijk");

    expect(stdoutEvents).toHaveLength(3);
    expect(stdoutEvents[0]?.mainBufferDroppedBytes).toBeUndefined();
    expect(stdoutEvents[1]?.mainBufferDroppedBytes).toBeUndefined();
    expect(stdoutEvents[2]?.mainBufferDroppedBytes).toBe(3);

    expect(
      registry.handleScrollbackStatsQuery({
        type: "terminal/scrollback-stats/query",
        tabId,
      }),
    ).toEqual({
      type: "terminal/scrollback-stats/reply",
      tabId,
      mainBufferByteLimit: 8,
      mainBufferStoredBytes: 8,
      mainBufferDroppedBytesTotal: 3,
      xtermScrollbackLines: 77,
    });
  });

  test("keeps ring buffers independent across tabs", () => {
    const alphaTabId = "tt_ws_alpha_ri_001" as TerminalTabId;
    const betaTabId = "tt_ws_alpha_ri_002" as TerminalTabId;

    const alphaHost = new FakeTerminalHost({
      tabId: alphaTabId,
      workspaceId: "ws_alpha",
      pid: 4201,
    });
    const betaHost = new FakeTerminalHost({
      tabId: betaTabId,
      workspaceId: "ws_alpha",
      pid: 4202,
    });

    const registry = new WorkspaceTerminalRegistry({
      defaultMainBufferByteLimit: DEFAULT_MAIN_BUFFER_BYTE_LIMIT,
      defaultXtermScrollbackLines: DEFAULT_XTERM_SCROLLBACK_LINES,
    });

    registry.registerHost(alphaHost, {
      mainBufferByteLimit: 6,
      xtermScrollbackLines: 100,
    });
    registry.registerHost(betaHost, {
      mainBufferByteLimit: 4,
      xtermScrollbackLines: 200,
    });

    alphaHost.emitStdout("abcdef");
    alphaHost.emitStdout("g");

    betaHost.emitStdout("abc");
    betaHost.emitStdout("def");

    expect(
      registry.handleScrollbackStatsQuery({
        type: "terminal/scrollback-stats/query",
        tabId: alphaTabId,
      }),
    ).toEqual({
      type: "terminal/scrollback-stats/reply",
      tabId: alphaTabId,
      mainBufferByteLimit: 6,
      mainBufferStoredBytes: 6,
      mainBufferDroppedBytesTotal: 1,
      xtermScrollbackLines: 100,
    });

    expect(
      registry.handleScrollbackStatsQuery({
        type: "terminal/scrollback-stats/query",
        tabId: betaTabId,
      }),
    ).toEqual({
      type: "terminal/scrollback-stats/reply",
      tabId: betaTabId,
      mainBufferByteLimit: 4,
      mainBufferStoredBytes: 4,
      mainBufferDroppedBytesTotal: 2,
      xtermScrollbackLines: 200,
    });
  });

  test("workspace close kills owned hosts in order and emits lifecycle event", async () => {
    const alphaTabA = "tt_ws_alpha_close_001" as TerminalTabId;
    const alphaTabB = "tt_ws_alpha_close_002" as TerminalTabId;
    const betaTab = "tt_ws_beta_close_001" as TerminalTabId;

    const alphaHostA = new FakeTerminalHost({
      tabId: alphaTabA,
      workspaceId: "ws_alpha",
      pid: 4301,
    });
    const alphaHostB = new FakeTerminalHost({
      tabId: alphaTabB,
      workspaceId: "ws_alpha",
      pid: 4302,
    });
    const betaHost = new FakeTerminalHost({
      tabId: betaTab,
      workspaceId: "ws_beta",
      pid: 4303,
    });

    const registry = new WorkspaceTerminalRegistry();
    registry.registerHost(alphaHostA);
    registry.registerHost(alphaHostB);
    registry.registerHost(betaHost);

    const closedEvents: Array<{
      workspaceId: WorkspaceId;
      closedTabIds: TerminalTabId[];
      reason: string;
    }> = [];
    registry.onWorkspaceTerminalsClosed((event) => {
      closedEvents.push({
        workspaceId: event.workspaceId,
        closedTabIds: event.closedTabIds,
        reason: event.reason,
      });
    });

    const closedEvent = await registry.closeWorkspaceTerminals("ws_alpha", "workspace-close");

    expect(alphaHostA.closeCalls).toEqual(["workspace-close"]);
    expect(alphaHostB.closeCalls).toEqual(["workspace-close"]);
    expect(betaHost.closeCalls).toEqual([]);

    expect(closedEvent).toEqual({
      type: "terminal/workspace-terminals-closed",
      workspaceId: "ws_alpha",
      closedTabIds: [alphaTabA, alphaTabB],
      reason: "workspace-close",
    });
    expect(closedEvents).toEqual([
      {
        workspaceId: "ws_alpha",
        closedTabIds: [alphaTabA, alphaTabB],
        reason: "workspace-close",
      },
    ]);

    expect(registry.hasTab(alphaTabA)).toBe(false);
    expect(registry.hasTab(alphaTabB)).toBe(false);
    expect(registry.hasTab(betaTab)).toBe(true);
    expect(registry.listTabIdsForWorkspace("ws_alpha")).toEqual([]);
    expect(registry.listTabIdsForWorkspace("ws_beta")).toEqual([betaTab]);
    expect(
      registry.handleScrollbackStatsQuery({
        type: "terminal/scrollback-stats/query",
        tabId: alphaTabA,
      }),
    ).toBeNull();
  });
});

class FakeHostFactory implements WorkspaceTerminalHostFactory {
  public readonly createCalls: MainHostCreateCall[] = [];

  public async create(options: TerminalHostCreateOptions): Promise<WorkspaceTerminalHost> {
    this.createCalls.push({
      tabId: options.tabId,
      workspaceId: options.openCommand.workspaceId,
    });

    return new FakeTerminalHost({
      tabId: options.tabId,
      workspaceId: options.openCommand.workspaceId,
      pid: 5000 + this.createCalls.length,
    });
  }
}

type MainHostCreateCall = {
  tabId: TerminalTabId;
  workspaceId: WorkspaceId;
};

class FakeTerminalHost implements WorkspaceTerminalHost {
  public readonly closeCalls: string[] = [];
  public readonly writeCalls: string[] = [];
  public readonly resizeCalls: Array<{ cols: number; rows: number }> = [];

  private readonly stdoutListeners = new Set<(chunk: TerminalStdoutChunk) => void>();
  private readonly exitListeners = new Set<(event: TerminalExitedEvent) => void>();
  private seq = 0;
  private exitEvent: TerminalExitedEvent | null = null;

  public readonly tabId: TerminalTabId;
  public readonly workspaceId: WorkspaceId;
  private readonly pid: number;

  public constructor(options: {
    tabId: TerminalTabId;
    workspaceId: WorkspaceId;
    pid: number;
  }) {
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

  public async close(reason: "user-close" | "workspace-close" | "app-shutdown") {
    this.closeCalls.push(reason);

    if (this.exitEvent) {
      return this.exitEvent;
    }

    const exitEvent: TerminalExitedEvent = {
      type: "terminal/exited",
      tabId: this.tabId,
      workspaceId: this.workspaceId,
      reason,
      exitCode: 0,
    };
    this.emitExit(exitEvent);
    return exitEvent;
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

function createHostOptions(
  tabId: TerminalTabId,
  workspaceId: WorkspaceId,
  openCommandOverrides: Partial<TerminalOpenCommand> = {},
): TerminalHostCreateOptions {
  return {
    tabId,
    shellEnvironmentResolver: TEST_ENVIRONMENT_RESOLVER,
    openCommand: {
      type: "terminal/open",
      workspaceId,
      cols: 120,
      rows: 32,
      ...openCommandOverrides,
    },
  };
}
