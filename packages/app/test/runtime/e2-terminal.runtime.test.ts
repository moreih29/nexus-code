import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  TerminalCloseCommand,
  TerminalExitedEvent,
  TerminalScrollbackStatsReply,
  TerminalStdoutChunk,
} from "../../../shared/src/contracts/terminal-ipc";
import type { WorkspaceSidebarState } from "../../../shared/src/contracts/workspace-shell";
import type { TerminalCloseReason } from "../../../shared/src/contracts/terminal-lifecycle";
import type { TerminalTabId } from "../../../shared/src/contracts/terminal-tab";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import type { TerminalHostCreateOptions, TerminalHostEnvironmentResolver } from "../../src/main/terminal-host";
import {
  WorkspaceTerminalRegistry,
  type WorkspaceTerminalHost,
  type WorkspaceTerminalHostFactory,
} from "../../src/main/workspace-terminal-registry";
import {
  ShellTerminalTabs,
  type ShellTerminalClipboard,
  type ShellTerminalSessionAdapter,
  type ShellTerminalTabView,
  type ShellTerminalTabViewCreateOptions,
  type ShellTerminalTabViewFactory,
} from "../../src/renderer/shell-terminal-tab";

const EVIDENCE_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../artifacts/runtime-terminal",
);
const EVIDENCE_JSON_PATH = path.join(EVIDENCE_DIRECTORY, "latest.json");
const EVIDENCE_MARKDOWN_PATH = path.join(EVIDENCE_DIRECTORY, "latest.md");

const SWITCH_ITERATIONS = 120;
const SWITCH_STALL_THRESHOLD_MS = 100;
const WORKSPACES: RuntimeWorkspaceFixture[] = [
  {
    id: "ws_alpha",
    absolutePath: "/tmp/runtime/ws-alpha",
    displayName: "Alpha",
  },
  {
    id: "ws_beta",
    absolutePath: "/tmp/runtime/ws-beta",
    displayName: "Beta",
  },
  {
    id: "ws_gamma",
    absolutePath: "/tmp/runtime/ws-gamma",
    displayName: "Gamma",
  },
];

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

describe("E2 terminal runtime verification harness", () => {
  test("exercises workspace switching, tab lifecycle, leak model checks, and scrollback drop metrics", async () => {
    const document = new FakeDocument();
    const paneHost = new FakeElement(document);
    const clipboard = new FakeClipboard();
    const viewFactory = new RuntimeViewFactory();
    const hostFactory = new RuntimeHostFactory();
    const registry = new WorkspaceTerminalRegistry({
      hostFactory,
      defaultMainBufferByteLimit: 512,
      defaultXtermScrollbackLines: 4_000,
    });
    const session = new RuntimeSessionAdapter(registry);
    const shellTabs = new ShellTerminalTabs({
      terminalPaneHost: paneHost as unknown as HTMLElement,
      session,
      clipboard,
      viewFactory,
    });

    const observedStdoutChunks: TerminalStdoutChunk[] = [];
    registry.onStdout((chunk) => {
      observedStdoutChunks.push(chunk);
      shellTabs.writeToTab(chunk.tabId, chunk.data);
    });

    await shellTabs.syncSidebarState(buildSidebarState(["ws_alpha", "ws_beta", "ws_gamma"], "ws_alpha"));
    await shellTabs.createTab("ws_alpha", false);
    await shellTabs.createTab("ws_beta", false);
    await shellTabs.createTab("ws_gamma", false);

    const initialSnapshot = shellTabs.getSnapshot();
    const workspaceTabs = collectWorkspaceTabs(initialSnapshot);
    const allTabIds = flattenWorkspaceTabs(workspaceTabs);

    expect(initialSnapshot.workspaces).toHaveLength(3);
    for (const workspace of initialSnapshot.workspaces) {
      expect(workspace.tabs).toHaveLength(2);
    }
    expect(viewFactory.createCalls).toHaveLength(6);
    expect(hostFactory.getActiveHostCount()).toBe(6);

    const longTailTabId = workspaceTabs.get("ws_alpha")?.[1];
    expect(longTailTabId).toBeDefined();
    const longTailHost = hostFactory.requireHost(longTailTabId!);

    const scrollbackBefore = captureScrollbackStats(registry, allTabIds);

    const switchDurationsMs: number[] = [];
    const workspaceSwitchOrder: WorkspaceId[] = ["ws_alpha", "ws_beta", "ws_gamma"];

    for (let index = 0; index < SWITCH_ITERATIONS; index += 1) {
      const startedAt = performance.now();

      const workspaceId = workspaceSwitchOrder[index % workspaceSwitchOrder.length]!;
      const tabIds = workspaceTabs.get(workspaceId) ?? [];
      const tabId = tabIds[index % tabIds.length]!;

      shellTabs.activateWorkspace(workspaceId);
      shellTabs.activateTab(tabId);

      longTailHost.emitStdout(buildLongTailChunk(index));

      switchDurationsMs.push(performance.now() - startedAt);
    }

    const createCountAfterSwitches = viewFactory.createCalls.length;
    expect(createCountAfterSwitches).toBe(6);

    for (const tabId of allTabIds) {
      expect(viewFactory.viewsByTabId.get(tabId)?.mountCount).toBe(1);
    }

    const longTailView = viewFactory.viewsByTabId.get(longTailTabId!);
    expect(longTailView?.writes).toHaveLength(SWITCH_ITERATIONS);

    const scrollbackAfterLongTail = captureScrollbackStats(registry, allTabIds);
    const longTailScrollbackBefore = scrollbackBefore.get(longTailTabId!);
    const longTailScrollbackAfter = scrollbackAfterLongTail.get(longTailTabId!);

    expect(longTailScrollbackBefore).toBeDefined();
    expect(longTailScrollbackAfter).toBeDefined();
    expect(longTailScrollbackAfter!.mainBufferDroppedBytesTotal).toBeGreaterThan(
      longTailScrollbackBefore!.mainBufferDroppedBytesTotal,
    );

    const longTailDroppedBytesFromStdout = observedStdoutChunks
      .filter((chunk) => chunk.tabId === longTailTabId)
      .reduce((total, chunk) => total + (chunk.mainBufferDroppedBytes ?? 0), 0);
    expect(longTailDroppedBytesFromStdout).toBeGreaterThan(0);

    const ptyCountSnapshots: RuntimePtyCountSnapshot[] = [];
    const recordPtyCount = (phase: string, expectedActiveHosts: number) => {
      ptyCountSnapshots.push({
        phase,
        expectedActiveHosts,
        activeHosts: hostFactory.getActiveHostCount(),
      });
    };

    recordPtyCount("after-open", 6);

    const gammaPrimaryTabId = workspaceTabs.get("ws_gamma")?.[0];
    expect(gammaPrimaryTabId).toBeDefined();
    await shellTabs.closeTab(gammaPrimaryTabId!);
    recordPtyCount("after-gamma-primary-user-close", 5);

    await registry.closeWorkspaceTerminals("ws_alpha", "workspace-close");
    await shellTabs.syncSidebarState(buildSidebarState(["ws_beta", "ws_gamma"], "ws_beta"));
    recordPtyCount("after-ws-alpha-close", 3);

    await registry.closeWorkspaceTerminals("ws_beta", "workspace-close");
    await shellTabs.syncSidebarState(buildSidebarState(["ws_gamma"], "ws_gamma"));
    recordPtyCount("after-ws-beta-close", 1);

    await registry.closeWorkspaceTerminals("ws_gamma", "workspace-close");
    await shellTabs.syncSidebarState(buildSidebarState([], null));
    recordPtyCount("after-ws-gamma-close", 0);

    for (const snapshot of ptyCountSnapshots) {
      expect(snapshot.activeHosts).toBe(snapshot.expectedActiveHosts);
    }

    const stalledSwitches = switchDurationsMs.filter(
      (durationMs) => durationMs > SWITCH_STALL_THRESHOLD_MS,
    );
    expect(stalledSwitches).toHaveLength(0);

    const runtimeEvidence: RuntimeEvidence = {
      generatedAt: new Date().toISOString(),
      scenario: {
        workspaceCount: WORKSPACES.length,
        tabsPerWorkspace: 2,
        switchIterations: SWITCH_ITERATIONS,
        longTailEmitterTabId: longTailTabId!,
      },
      switching: {
        maxDurationMs: Math.max(...switchDurationsMs),
        minDurationMs: Math.min(...switchDurationsMs),
        stallThresholdMs: SWITCH_STALL_THRESHOLD_MS,
        stalledIterations: stalledSwitches.length,
      },
      xtermInstances: {
        createdViews: viewFactory.createCalls.length,
        createCountAfterSwitches,
        mountCountByTabId: Object.fromEntries(
          allTabIds.map((tabId) => [tabId, viewFactory.viewsByTabId.get(tabId)?.mountCount ?? 0]),
        ),
        reinitializedAcrossSwitches: createCountAfterSwitches !== 6,
      },
      longTailStream: {
        emittedChunkCount: SWITCH_ITERATIONS,
        observedStdoutChunkCount: observedStdoutChunks.filter((chunk) => chunk.tabId === longTailTabId)
          .length,
        droppedBytesFromStdoutAnnotations: longTailDroppedBytesFromStdout,
      },
      scrollbackSnapshots: {
        beforeLongTailByTab: serializeScrollbackMap(scrollbackBefore),
        afterLongTailByTab: serializeScrollbackMap(scrollbackAfterLongTail),
      },
      ptyCounts: ptyCountSnapshots,
      successCriteria: {
        switchingWithoutStalls: stalledSwitches.length === 0,
        noModelLevelLeaksAfterClose:
          ptyCountSnapshots[ptyCountSnapshots.length - 1]?.activeHosts === 0,
      },
      fullAppProcessCheck: {
        status: "pending-full-app-runtime",
        reason:
          "Deterministic harness runs on fake host/Xterm seams; real ps/pgrep zombie checks require full Electron runtime.",
        hookCommand: "bun run test:runtime-terminal:zombie-check",
      },
    };

    await writeRuntimeEvidence(runtimeEvidence);

    expect(runtimeEvidence.successCriteria.switchingWithoutStalls).toBeTrue();
    expect(runtimeEvidence.successCriteria.noModelLevelLeaksAfterClose).toBeTrue();
  });
});

type RuntimeWorkspaceFixture = {
  id: WorkspaceId;
  absolutePath: string;
  displayName: string;
};

type RuntimePtyCountSnapshot = {
  phase: string;
  expectedActiveHosts: number;
  activeHosts: number;
};

type RuntimeEvidence = {
  generatedAt: string;
  scenario: {
    workspaceCount: number;
    tabsPerWorkspace: number;
    switchIterations: number;
    longTailEmitterTabId: TerminalTabId;
  };
  switching: {
    maxDurationMs: number;
    minDurationMs: number;
    stallThresholdMs: number;
    stalledIterations: number;
  };
  xtermInstances: {
    createdViews: number;
    createCountAfterSwitches: number;
    mountCountByTabId: Record<string, number>;
    reinitializedAcrossSwitches: boolean;
  };
  longTailStream: {
    emittedChunkCount: number;
    observedStdoutChunkCount: number;
    droppedBytesFromStdoutAnnotations: number;
  };
  scrollbackSnapshots: {
    beforeLongTailByTab: Record<string, TerminalScrollbackStatsReply>;
    afterLongTailByTab: Record<string, TerminalScrollbackStatsReply>;
  };
  ptyCounts: RuntimePtyCountSnapshot[];
  successCriteria: {
    switchingWithoutStalls: boolean;
    noModelLevelLeaksAfterClose: boolean;
  };
  fullAppProcessCheck: {
    status: "pending-full-app-runtime";
    reason: string;
    hookCommand: string;
  };
};

class FakeElement {
  public children: FakeElement[] = [];
  public readonly style: { display?: string } = {};
  public readonly attributes = new Map<string, string>();
  public readonly ownerDocument?: FakeDocument;

  public constructor(ownerDocument?: FakeDocument) {
    this.ownerDocument = ownerDocument;
  }

  public appendChild(child: unknown): void {
    this.children.push(child as FakeElement);
  }

  public removeChild(child: unknown): void {
    this.children = this.children.filter((existing) => existing !== child);
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakeDocument {
  public createElement(_tagName: string): FakeElement {
    return new FakeElement(this);
  }
}

class FakeClipboard implements ShellTerminalClipboard {
  public async readText(): Promise<string> {
    return "";
  }

  public async writeText(_value: string): Promise<void> {}
}

class RuntimeView implements ShellTerminalTabView {
  public mountCount = 0;
  public unmountCount = 0;
  public fitCount = 0;
  public readonly writes: string[] = [];

  public mount(_container: HTMLElement | null | undefined): boolean {
    this.mountCount += 1;
    return true;
  }

  public unmount(): void {
    this.unmountCount += 1;
  }

  public fit(): void {
    this.fitCount += 1;
  }

  public focus(): void {
    // no-op for the runtime harness fake view
  }

  public write(data: string): void {
    this.writes.push(data);
  }

  public searchNext(_term: string): boolean {
    return true;
  }

  public searchPrevious(_term: string): boolean {
    return true;
  }

  public hasSelection(): boolean {
    return false;
  }

  public getSelection(): string {
    return "";
  }

  public onSelectionChange(_listener: () => void): { dispose(): void } {
    return {
      dispose: () => undefined,
    };
  }
}

class RuntimeViewFactory implements ShellTerminalTabViewFactory {
  public readonly createCalls: ShellTerminalTabViewCreateOptions[] = [];
  public readonly viewsByTabId = new Map<TerminalTabId, RuntimeView>();

  public create(options: ShellTerminalTabViewCreateOptions): ShellTerminalTabView {
    this.createCalls.push(options);
    const view = new RuntimeView();
    this.viewsByTabId.set(options.tabId, view);
    return view;
  }
}

class RuntimeSessionAdapter implements ShellTerminalSessionAdapter {
  private readonly nextNonceByWorkspaceId = new Map<WorkspaceId, number>();

  public constructor(private readonly registry: WorkspaceTerminalRegistry) {}

  public async openTab(workspaceId: WorkspaceId): Promise<{ tabId: TerminalTabId }> {
    const nextNonce = this.nextNonceByWorkspaceId.get(workspaceId) ?? 1;
    this.nextNonceByWorkspaceId.set(workspaceId, nextNonce + 1);

    const tabId = `tt_${workspaceId}_${nextNonce.toString(36).padStart(4, "0")}` as TerminalTabId;
    await this.registry.openTerminal({
      tabId,
      shellEnvironmentResolver: TEST_ENVIRONMENT_RESOLVER,
      openCommand: {
        type: "terminal/open",
        workspaceId,
        cols: 120,
        rows: 32,
        scrollbackMainBufferBytes: 512,
        scrollbackXtermLines: 4_000,
      },
    });

    return { tabId };
  }

  public async closeTab(tabId: TerminalTabId): Promise<void> {
    const command: TerminalCloseCommand = {
      type: "terminal/close",
      tabId,
      reason: "user-close",
    };
    await this.registry.handleCloseCommand(command);
  }

  public async input(tabId: TerminalTabId, data: string): Promise<void> {
    this.registry.handleInputCommand({
      type: "terminal/input",
      tabId,
      data,
    });
  }

  public async resize(tabId: TerminalTabId, cols: number, rows: number): Promise<void> {
    this.registry.handleResizeCommand({
      type: "terminal/resize",
      tabId,
      cols,
      rows,
    });
  }
}

class RuntimeHostFactory implements WorkspaceTerminalHostFactory {
  private nextPid = 12_000;

  public readonly hostsByTabId = new Map<TerminalTabId, RuntimeTerminalHost>();
  private readonly activeTabIds = new Set<TerminalTabId>();

  public async create(options: TerminalHostCreateOptions): Promise<WorkspaceTerminalHost> {
    const host = new RuntimeTerminalHost({
      tabId: options.tabId,
      workspaceId: options.openCommand.workspaceId,
      pid: this.nextPid,
    });
    this.nextPid += 1;

    host.onExit(() => {
      this.activeTabIds.delete(host.tabId);
    });

    this.hostsByTabId.set(host.tabId, host);
    this.activeTabIds.add(host.tabId);
    return host;
  }

  public getActiveHostCount(): number {
    return this.activeTabIds.size;
  }

  public requireHost(tabId: TerminalTabId): RuntimeTerminalHost {
    const host = this.hostsByTabId.get(tabId);
    if (!host) {
      throw new Error(`Missing runtime host for tab ${tabId}.`);
    }
    return host;
  }
}

class RuntimeTerminalHost implements WorkspaceTerminalHost {
  public readonly tabId: TerminalTabId;
  public readonly workspaceId: WorkspaceId;

  private readonly pid: number;
  private readonly stdoutListeners = new Set<(chunk: TerminalStdoutChunk) => void>();
  private readonly exitListeners = new Set<(event: TerminalExitedEvent) => void>();

  private exitEvent: TerminalExitedEvent | null = null;
  private sequence = 0;

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

  public write(_data: string): void {}

  public resize(_cols: number, _rows: number): void {}

  public async close(reason: TerminalCloseReason): Promise<TerminalExitedEvent> {
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
    if (this.exitEvent) {
      return;
    }

    const chunk: TerminalStdoutChunk = {
      type: "terminal/stdout",
      tabId: this.tabId,
      seq: this.sequence,
      data,
    };
    this.sequence += 1;

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

function buildSidebarState(
  openWorkspaceIds: WorkspaceId[],
  activeWorkspaceId: WorkspaceId | null,
): WorkspaceSidebarState {
  const workspaceById = new Map(WORKSPACES.map((workspace) => [workspace.id, workspace]));
  return {
    openWorkspaces: openWorkspaceIds.map((workspaceId) => {
      const workspace = workspaceById.get(workspaceId);
      if (!workspace) {
        throw new Error(`Unknown workspace id: ${workspaceId}`);
      }
      return {
        id: workspace.id,
        absolutePath: workspace.absolutePath,
        displayName: workspace.displayName,
      };
    }),
    activeWorkspaceId,
  };
}

function collectWorkspaceTabs(snapshot: ReturnType<ShellTerminalTabs["getSnapshot"]>) {
  const workspaceTabs = new Map<WorkspaceId, TerminalTabId[]>();
  for (const workspace of snapshot.workspaces) {
    workspaceTabs.set(
      workspace.workspaceId,
      workspace.tabs.map((tab) => tab.tabId),
    );
  }
  return workspaceTabs;
}

function flattenWorkspaceTabs(workspaceTabs: Map<WorkspaceId, TerminalTabId[]>): TerminalTabId[] {
  return Array.from(workspaceTabs.values()).flat();
}

function buildLongTailChunk(index: number): string {
  return `stream-${index.toString().padStart(4, "0")}:${"x".repeat(256)}\n`;
}

function captureScrollbackStats(
  registry: WorkspaceTerminalRegistry,
  tabIds: TerminalTabId[],
): Map<TerminalTabId, TerminalScrollbackStatsReply> {
  const statsByTabId = new Map<TerminalTabId, TerminalScrollbackStatsReply>();

  for (const tabId of tabIds) {
    const stats = registry.handleScrollbackStatsQuery({
      type: "terminal/scrollback-stats/query",
      tabId,
    });
    if (!stats) {
      continue;
    }
    statsByTabId.set(tabId, stats);
  }

  return statsByTabId;
}

function serializeScrollbackMap(
  map: Map<TerminalTabId, TerminalScrollbackStatsReply>,
): Record<string, TerminalScrollbackStatsReply> {
  return Object.fromEntries(Array.from(map.entries()));
}

async function writeRuntimeEvidence(evidence: RuntimeEvidence): Promise<void> {
  await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
  await writeFile(EVIDENCE_JSON_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await writeFile(EVIDENCE_MARKDOWN_PATH, toMarkdown(evidence), "utf8");
}

function toMarkdown(evidence: RuntimeEvidence): string {
  const ptyRows = evidence.ptyCounts
    .map(
      (snapshot) =>
        `- ${snapshot.phase}: expected ${snapshot.expectedActiveHosts}, observed ${snapshot.activeHosts}`,
    )
    .join("\n");

  return [
    "# Runtime Verification Evidence — Task 13",
    "",
    `- Generated at: ${evidence.generatedAt}`,
    `- Workspaces/Tabs: ${evidence.scenario.workspaceCount} workspaces × ${evidence.scenario.tabsPerWorkspace} tabs`,
    `- Workspace switches: ${evidence.scenario.switchIterations}`,
    `- Stall threshold: ${evidence.switching.stallThresholdMs}ms`,
    `- Stalled iterations: ${evidence.switching.stalledIterations}`,
    `- Long-tail dropped bytes: ${evidence.longTailStream.droppedBytesFromStdoutAnnotations}`,
    "",
    "## PTY Count Snapshots",
    ptyRows,
    "",
    "## Full-app Zombie Check",
    `- Status: ${evidence.fullAppProcessCheck.status}`,
    `- Reason: ${evidence.fullAppProcessCheck.reason}`,
    `- Hook command: ${evidence.fullAppProcessCheck.hookCommand}`,
    "",
  ].join("\n");
}
