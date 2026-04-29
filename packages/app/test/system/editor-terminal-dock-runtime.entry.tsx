import { StrictMode, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useStore } from "zustand";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import type { WorkspaceSidebarState } from "../../../shared/src/contracts/workspace/workspace-shell";
import { moveTerminalToEditorArea } from "../../src/renderer/app/terminal-move-commands";
import { CenterWorkbench, type CenterWorkbenchActiveArea } from "../../src/renderer/components/CenterWorkbench";
import { BottomPanelPart } from "../../src/renderer/parts/bottom-panel/BottomPanelPart";
import { EditorGroupsPart } from "../../src/renderer/parts/editor-groups/EditorGroupsPart";
import {
  createBottomPanelService,
  type BottomPanelServiceStore,
} from "../../src/renderer/services/bottom-panel-service";
import {
  DEFAULT_EDITOR_GROUP_ID,
  createEditorGroupsService,
  type EditorGroup,
  type EditorGroupsServiceStore,
} from "../../src/renderer/services/editor-groups-service";
import type { EditorPaneState } from "../../src/renderer/services/editor-types";
import {
  createTerminalService,
  type TerminalServiceStore,
  type TerminalServiceTerminalCreateOptions,
  type TerminalServiceTerminalLike,
  type TerminalServiceXtermDependencies,
  type TerminalTabId,
} from "../../src/renderer/services/terminal-service";
import {
  createWorkspaceService,
  type WorkspaceServiceStore,
} from "../../src/renderer/services/workspace-service";
import { createWorkspaceStore, type WorkspaceStore } from "../../src/renderer/stores/workspace-store";
import "../../src/renderer/styles.css";
import "../../src/renderer/parts/editor-groups/flexlayout-theme.css";

const RESULT_GLOBAL_NAME = "__nexusEditorTerminalDockRuntimeSmokeResult";
const WORKSPACE_ID = "ws_editor_terminal_dock" as WorkspaceId;
const TERMINAL_ALPHA_ID = "terminal_dock_alpha" as TerminalTabId;
const TERMINAL_BETA_ID = "terminal_dock_beta" as TerminalTabId;
const SPLIT_GROUP_ID = "group_terminal_split";
const RESTORE_TIMEOUT_MS = 5_000;

interface RuntimeScenarioResult {
  name:
    | "bottom-panel-to-editor move"
    | "editor split with terminal"
    | "two terminals dock in editor area"
    | "pty data preserved during move";
  passed: boolean;
  evidence: Record<string, unknown>;
  reason?: string;
}

interface RuntimeTerminalSnapshot {
  sessionId: TerminalTabId;
  instanceId: number | null;
  writeLog: string[];
  mountHostDescriptions: string[];
  currentHostDescription: string | null;
  currentHostArea: string | null;
  currentHostGroupId: string | null;
  focusCount: number;
  fitCount: number;
  detachCount: number;
  disposeCount: number;
}

interface EditorTerminalDockRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  scenarios: RuntimeScenarioResult[];
  dockState: {
    bottomDetachedTerminalIds: string[];
    bottomAttachedTerminalIds: string[];
    editorTerminalTabIds: string[];
    uniqueEditorTerminalTabIds: string[];
    groupByTerminalId: Record<string, string | null>;
    groupsByTerminalId: Record<string, string[]>;
    centerMode: string;
    activeCenterArea: CenterWorkbenchActiveArea;
  };
  ptyEvidence: {
    alphaInstanceIdBeforeMove: number | null;
    alphaInstanceIdAfterMove: number | null;
    alphaSameInstanceAfterMove: boolean;
    alphaWriteLog: string[];
    alphaDataEvents: string[];
    betaWriteLog: string[];
    terminalCreateCount: number;
  };
  terminalSnapshots: RuntimeTerminalSnapshot[];
  reason?: string;
}

interface RuntimeServices {
  bottomPanel: BottomPanelServiceStore;
  editorGroups: EditorGroupsServiceStore;
  editorWorkspace: WorkspaceServiceStore;
  terminal: TerminalServiceStore;
  workspace: WorkspaceStore;
  sidebarState: WorkspaceSidebarState;
  activeCenterArea: CenterWorkbenchActiveArea;
  setActiveCenterArea(area: CenterWorkbenchActiveArea): void;
}

declare global {
  interface Window {
    __nexusEditorTerminalDockRuntimeSmokeResult?: EditorTerminalDockRuntimeSmokeResult;
  }
}

const capturedErrors: string[] = [];
const suspiciousMessagePattern =
  /Maximum update depth exceeded|Cannot update a component|error boundary|uncaught|unhandled|getSnapshot should be cached|Could not create web worker|Uncaught \[object Event\]|Uncaught Event/i;

installConsoleCapture();

async function runSmoke(): Promise<void> {
  let root: Root | null = null;

  try {
    const rootElement = document.getElementById("app");
    if (!rootElement) {
      publishResult(failedResult("Missing #app root."));
      return;
    }

    prepareDocument(rootElement);
    const dependencies = new RuntimeXtermDependencies();
    const services = createRuntimeServices(dependencies);
    seedRuntimeServices(services);

    root = createRoot(rootElement);
    root.render(
      <StrictMode>
        <EditorTerminalDockRuntimeFixture services={services} />
      </StrictMode>,
    );

    await waitForSelector('[data-fixture="editor-terminal-dock-runtime"]', rootElement, RESTORE_TIMEOUT_MS);
    await waitUntil(
      () => dependencies.terminalForSession(TERMINAL_ALPHA_ID)?.currentHostArea === "bottom-panel" &&
        dependencies.terminalForSession(TERMINAL_BETA_ID)?.currentHostArea === "bottom-panel",
      RESTORE_TIMEOUT_MS,
      () => `Timed out waiting for bottom-panel terminal hosts: ${JSON.stringify(collectTerminalSnapshots(dependencies))}`,
    );

    services.terminal.getState().receiveData({
      tabId: TERMINAL_ALPHA_ID,
      seq: 1,
      data: "alpha before move\r\n",
    });
    services.terminal.getState().receiveData({
      tabId: TERMINAL_BETA_ID,
      seq: 1,
      data: "beta ready\r\n",
    });
    await animationFrame();

    const alphaInstanceIdBeforeMove = dependencies.terminalForSession(TERMINAL_ALPHA_ID)?.id ?? null;
    moveTerminalToEditorArea({
      bottomPanelStore: services.bottomPanel,
      editorGroupsService: services.editorGroups,
      editorWorkspaceService: services.editorWorkspace,
      sessionId: TERMINAL_ALPHA_ID,
      targetGroupId: DEFAULT_EDITOR_GROUP_ID,
      terminalService: services.terminal,
      workspaceStore: services.workspace,
      setActiveCenterArea: services.setActiveCenterArea,
    });
    services.terminal.getState().receiveData({
      tabId: TERMINAL_ALPHA_ID,
      seq: 2,
      data: "alpha during move\r\n",
    });

    await waitUntil(
      () => groupContainingTerminal(services.editorGroups.getState().groups, TERMINAL_ALPHA_ID) !== null &&
        dependencies.terminalForSession(TERMINAL_ALPHA_ID)?.currentHostArea === "editor",
      RESTORE_TIMEOUT_MS,
      () => `Timed out waiting for ${TERMINAL_ALPHA_ID} in editor: ${JSON.stringify(collectDockState(services))}`,
    );

    services.terminal.getState().receiveData({
      tabId: TERMINAL_ALPHA_ID,
      seq: 3,
      data: "alpha after editor attach\r\n",
    });
    await animationFrame();

    const bottomPanelMoveEvidence = {
      dockState: collectDockState(services),
      alphaTerminal: snapshotForSession(dependencies, TERMINAL_ALPHA_ID),
    };
    const bottomPanelMovePassed =
      services.bottomPanel.getState().detachedTerminalIds.includes(TERMINAL_ALPHA_ID) &&
      groupsContainingTerminal(services.editorGroups.getState().groups, TERMINAL_ALPHA_ID).length === 1 &&
      dependencies.terminalForSession(TERMINAL_ALPHA_ID)?.currentHostArea === "editor";

    const sourceGroupId = groupContainingTerminal(services.editorGroups.getState().groups, TERMINAL_ALPHA_ID);
    if (!sourceGroupId) {
      throw new Error(`Cannot split terminal ${TERMINAL_ALPHA_ID}; source group was not found.`);
    }
    services.editorGroups.getState().splitGroup({
      sourceGroupId,
      tabId: TERMINAL_ALPHA_ID,
      targetGroupId: SPLIT_GROUP_ID,
      direction: "right",
      activate: true,
    });

    await waitUntil(
      () => groupsContainingTerminal(services.editorGroups.getState().groups, TERMINAL_ALPHA_ID).includes(SPLIT_GROUP_ID),
      RESTORE_TIMEOUT_MS,
      () => `Timed out waiting for split group ${SPLIT_GROUP_ID}: ${JSON.stringify(collectDockState(services))}`,
    );
    await animationFrame();

    const splitEvidence = {
      dockState: collectDockState(services),
      alphaTerminal: snapshotForSession(dependencies, TERMINAL_ALPHA_ID),
    };
    const splitAlphaGroups = groupsContainingTerminal(services.editorGroups.getState().groups, TERMINAL_ALPHA_ID);
    const splitPassed = splitAlphaGroups.includes(sourceGroupId) &&
      splitAlphaGroups.includes(SPLIT_GROUP_ID) &&
      services.editorGroups.getState().groups.length >= 2;

    moveTerminalToEditorArea({
      bottomPanelStore: services.bottomPanel,
      editorGroupsService: services.editorGroups,
      editorWorkspaceService: services.editorWorkspace,
      sessionId: TERMINAL_BETA_ID,
      targetGroupId: DEFAULT_EDITOR_GROUP_ID,
      terminalService: services.terminal,
      workspaceStore: services.workspace,
      setActiveCenterArea: services.setActiveCenterArea,
    });
    services.terminal.getState().receiveData({
      tabId: TERMINAL_BETA_ID,
      seq: 2,
      data: "beta after editor attach\r\n",
    });

    await waitUntil(
      () => {
        const state = collectDockState(services);
        return state.uniqueEditorTerminalTabIds.includes(TERMINAL_ALPHA_ID) &&
          state.uniqueEditorTerminalTabIds.includes(TERMINAL_BETA_ID) &&
          state.bottomAttachedTerminalIds.length === 0 &&
          dependencies.terminalForSession(TERMINAL_BETA_ID)?.currentHostArea === "editor";
      },
      RESTORE_TIMEOUT_MS,
      () => `Timed out waiting for both terminals docked: ${JSON.stringify(collectDockState(services))}`,
    );
    await animationFrame();

    const twoTerminalEvidence = {
      dockState: collectDockState(services),
      alphaTerminal: snapshotForSession(dependencies, TERMINAL_ALPHA_ID),
      betaTerminal: snapshotForSession(dependencies, TERMINAL_BETA_ID),
    };
    const twoTerminalPassed =
      sameStringSet(collectDockState(services).uniqueEditorTerminalTabIds, [TERMINAL_ALPHA_ID, TERMINAL_BETA_ID]) &&
      collectDockState(services).groupsByTerminalId[TERMINAL_ALPHA_ID]?.length === 2 &&
      collectDockState(services).groupsByTerminalId[TERMINAL_BETA_ID]?.length === 1 &&
      collectDockState(services).bottomAttachedTerminalIds.length === 0 &&
      dependencies.terminals.length === 2;

    const alphaInstanceIdAfterMove = dependencies.terminalForSession(TERMINAL_ALPHA_ID)?.id ?? null;
    const alphaWriteLog = dependencies.terminalForSession(TERMINAL_ALPHA_ID)?.writes ?? [];
    const alphaDataEvents = services.terminal.getState().dataEvents
      .filter((event) => event.tabId === TERMINAL_ALPHA_ID)
      .map((event) => event.data);
    const ptyEvidence = {
      alphaInstanceIdBeforeMove,
      alphaInstanceIdAfterMove,
      alphaSameInstanceAfterMove: alphaInstanceIdBeforeMove !== null && alphaInstanceIdBeforeMove === alphaInstanceIdAfterMove,
      alphaWriteLog: [...alphaWriteLog],
      alphaDataEvents,
      betaWriteLog: [...(dependencies.terminalForSession(TERMINAL_BETA_ID)?.writes ?? [])],
      terminalCreateCount: dependencies.terminals.length,
    };
    const ptyPassed =
      ptyEvidence.alphaSameInstanceAfterMove &&
      ["alpha before move\r\n", "alpha during move\r\n", "alpha after editor attach\r\n"].every((chunk) =>
        ptyEvidence.alphaWriteLog.includes(chunk)
      ) &&
      ptyEvidence.alphaDataEvents.length === 3;

    const scenarios: RuntimeScenarioResult[] = [
      {
        name: "bottom-panel-to-editor move",
        passed: bottomPanelMovePassed,
        evidence: bottomPanelMoveEvidence,
        reason: bottomPanelMovePassed ? undefined : "Terminal did not detach from the bottom panel and attach to an editor group.",
      },
      {
        name: "editor split with terminal",
        passed: splitPassed,
        evidence: splitEvidence,
        reason: splitPassed ? undefined : `Terminal did not split into ${SPLIT_GROUP_ID} while staying docked in the editor area.`,
      },
      {
        name: "two terminals dock in editor area",
        passed: twoTerminalPassed,
        evidence: twoTerminalEvidence,
        reason: twoTerminalPassed ? undefined : "Both terminal tabs were not simultaneously docked in editor groups.",
      },
      {
        name: "pty data preserved during move",
        passed: ptyPassed,
        evidence: ptyEvidence,
        reason: ptyPassed ? undefined : "Terminal PTY data events or xterm instance identity were not preserved across the dock move.",
      },
    ];

    const fatalErrors = capturedErrors.filter((message) => suspiciousMessagePattern.test(message));
    const scenarioErrors = scenarios.filter((scenario) => !scenario.passed).map((scenario) => scenario.reason ?? scenario.name);
    const errors = [...fatalErrors, ...scenarioErrors];
    const ok = errors.length === 0 && scenarios.every((scenario) => scenario.passed);

    const finalDockState = collectDockState(services);
    const finalTerminalSnapshots = collectTerminalSnapshots(dependencies);

    root.unmount();
    root = null;

    publishResult({
      ok,
      errors,
      scenarios,
      dockState: finalDockState,
      ptyEvidence,
      terminalSnapshots: finalTerminalSnapshots,
      reason: errors[0],
    });
  } catch (error) {
    root?.unmount();
    publishResult(failedResult(stringifyErrorPart(error)));
  }
}

function EditorTerminalDockRuntimeFixture({ services }: { services: RuntimeServices }): JSX.Element {
  const groups = useStore(services.editorGroups, (state) => state.groups);
  const activeGroupId = useStore(services.editorGroups, (state) => state.activeGroupId);
  const layoutSnapshot = useStore(services.editorGroups, (state) => state.layoutSnapshot);
  const model = useStore(services.editorGroups, (state) => state.model);
  const bottomPanelViews = useStore(services.bottomPanel, (state) => state.views);
  const activeBottomPanelViewId = useStore(services.bottomPanel, (state) => state.activeViewId);
  const bottomPanelPosition = useStore(services.bottomPanel, (state) => state.position);
  const bottomPanelExpanded = useStore(services.bottomPanel, (state) => state.expanded);
  const bottomPanelHeight = useStore(services.bottomPanel, (state) => state.height);
  const detachedTerminalIds = useStore(services.bottomPanel, (state) => state.detachedTerminalIds);
  const centerMode = useStore(services.editorWorkspace, (state) => state.centerMode);
  const [activeCenterArea, setActiveCenterArea] = useState<CenterWorkbenchActiveArea>("bottom-panel");

  services.activeCenterArea = activeCenterArea;
  services.setActiveCenterArea = (area) => {
    services.activeCenterArea = area;
    setActiveCenterArea(area);
  };

  const panes = useMemo<EditorPaneState[]>(() => groups.map((group) => ({
    id: group.id,
    tabs: [],
    activeTabId: group.activeTabId,
  })), [groups]);
  const activePaneId = activeGroupId ?? groups[0]?.id ?? DEFAULT_EDITOR_GROUP_ID;

  return (
    <div data-fixture="editor-terminal-dock-runtime" className="h-screen min-h-0 bg-background text-foreground">
      <CenterWorkbench
        editorArea={
          <EditorGroupsPart
            activeGroupId={activeGroupId}
            groups={groups}
            editorGroupsService={services.editorGroups}
            terminalService={services.terminal}
            layoutSnapshot={layoutSnapshot ?? services.editorGroups.getState().serializeModel()}
            model={model}
            activeWorkspaceId={WORKSPACE_ID}
            activeWorkspaceName="Editor Terminal Dock"
            panes={panes}
            activePaneId={activePaneId}
            onActivatePane={(paneId) => services.editorGroups.getState().activateGroup(paneId)}
            onSplitRight={() => {
              const sourceGroupId = services.editorGroups.getState().activeGroupId ?? activePaneId;
              services.editorGroups.getState().splitGroup({ sourceGroupId, direction: "right", activate: true });
            }}
            onSplitTabRight={(sourcePaneId, tabId) => {
              services.editorGroups.getState().splitGroup({
                sourceGroupId: sourcePaneId,
                tabId,
                direction: "right",
                activate: true,
              });
            }}
            onCloseTab={(paneId, tabId) => services.editorGroups.getState().closeTab(paneId, tabId)}
            onSaveTab={() => {}}
            onChangeContent={() => {}}
            onDropExternalPayload={(input) => {
              services.editorGroups.getState().dropExternalPayload(input);
            }}
            onMoveTerminalToBottomPanel={() => {}}
          />
        }
        bottomPanel={
          <BottomPanelPart
            sidebarState={services.sidebarState}
            active={activeCenterArea === "bottom-panel"}
            views={bottomPanelViews}
            activeViewId={activeBottomPanelViewId}
            position={bottomPanelPosition}
            expanded={bottomPanelExpanded}
            onActiveViewChange={(viewId) => services.bottomPanel.getState().setActiveView(viewId)}
            terminalService={services.terminal}
            detachedTerminalIds={detachedTerminalIds}
            onMoveTerminalToEditorArea={(sessionId) => {
              moveTerminalToEditorArea({
                bottomPanelStore: services.bottomPanel,
                editorGroupsService: services.editorGroups,
                editorWorkspaceService: services.editorWorkspace,
                sessionId,
                terminalService: services.terminal,
                workspaceStore: services.workspace,
                setActiveCenterArea,
              });
            }}
            onDropTerminalTab={() => false}
          />
        }
        bottomPanelPosition={bottomPanelPosition}
        bottomPanelExpanded={bottomPanelExpanded}
        bottomPanelSize={bottomPanelHeight}
        editorMaximized={centerMode === "editor-max"}
        activeArea={activeCenterArea}
        onActiveAreaChange={setActiveCenterArea}
        onBottomPanelSizeChange={(size) => services.bottomPanel.getState().setHeight(size)}
      />
    </div>
  );
}

function createRuntimeServices(dependencies: RuntimeXtermDependencies): RuntimeServices {
  const sidebarState: WorkspaceSidebarState = {
    openWorkspaces: [{ id: WORKSPACE_ID, absolutePath: "/tmp/nexus-editor-terminal-dock", displayName: "Dock" }],
    activeWorkspaceId: WORKSPACE_ID,
  };
  const workspace = createWorkspaceStore({
    async getSidebarState() {
      return sidebarState;
    },
    async openFolder() {
      return sidebarState;
    },
    async activateWorkspace() {
      return sidebarState;
    },
    async closeWorkspace() {
      return sidebarState;
    },
  });
  workspace.getState().applySidebarState(sidebarState);

  const editorWorkspace = createWorkspaceService();
  editorWorkspace.getState().openWorkspace(sidebarState.openWorkspaces[0]!);

  return {
    bottomPanel: createBottomPanelService({ activeViewId: "terminal", expanded: true, position: "bottom", height: 260 }),
    editorGroups: createEditorGroupsService(),
    editorWorkspace,
    terminal: createTerminalService({}, dependencies),
    workspace,
    sidebarState,
    activeCenterArea: "bottom-panel",
    setActiveCenterArea: () => {},
  };
}

function seedRuntimeServices(services: RuntimeServices): void {
  services.terminal.getState().setActiveWorkspace(WORKSPACE_ID);
  services.terminal.getState().createTab({
    id: TERMINAL_ALPHA_ID,
    title: "Terminal 1",
    workspaceId: WORKSPACE_ID,
    status: "running",
    createdAt: "2026-04-29T00:00:00.000Z",
    activate: true,
  });
  services.terminal.getState().createTab({
    id: TERMINAL_BETA_ID,
    title: "Terminal 2",
    workspaceId: WORKSPACE_ID,
    status: "running",
    createdAt: "2026-04-29T00:00:01.000Z",
    activate: true,
  });
  services.bottomPanel.getState().attachTerminalToBottom(TERMINAL_ALPHA_ID);
  services.bottomPanel.getState().attachTerminalToBottom(TERMINAL_BETA_ID);
}

function collectDockState(services: RuntimeServices): EditorTerminalDockRuntimeSmokeResult["dockState"] {
  const bottomState = services.bottomPanel.getState();
  const terminalTabs = services.terminal.getState().tabs;
  const groups = services.editorGroups.getState().groups;
  const editorTerminalTabIds = groups.flatMap((group) =>
    group.tabs.filter((tab) => tab.kind === "terminal").map((tab) => tab.id),
  );
  const uniqueEditorTerminalTabIds = Array.from(new Set(editorTerminalTabIds)).sort();
  const groupByTerminalId = Object.fromEntries(
    terminalTabs.map((tab) => [tab.id, groupContainingTerminal(groups, tab.id)]),
  );
  const groupsByTerminalId = Object.fromEntries(
    terminalTabs.map((tab) => [tab.id, groupsContainingTerminal(groups, tab.id)]),
  );

  return {
    bottomDetachedTerminalIds: [...bottomState.detachedTerminalIds],
    bottomAttachedTerminalIds: terminalTabs
      .filter((tab) => bottomState.isTerminalAttachedToBottom(tab.id))
      .map((tab) => tab.id),
    editorTerminalTabIds,
    uniqueEditorTerminalTabIds,
    groupByTerminalId,
    groupsByTerminalId,
    centerMode: services.editorWorkspace.getState().centerMode,
    activeCenterArea: services.activeCenterArea,
  };
}

function groupContainingTerminal(groups: readonly EditorGroup[], sessionId: TerminalTabId): string | null {
  return groupsContainingTerminal(groups, sessionId)[0] ?? null;
}

function groupsContainingTerminal(groups: readonly EditorGroup[], sessionId: TerminalTabId): string[] {
  return groups
    .filter((group) => group.tabs.some((tab) => tab.kind === "terminal" && tab.id === sessionId))
    .map((group) => group.id);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function collectTerminalSnapshots(dependencies: RuntimeXtermDependencies): RuntimeTerminalSnapshot[] {
  return [TERMINAL_ALPHA_ID, TERMINAL_BETA_ID].map((sessionId) => snapshotForSession(dependencies, sessionId));
}

function snapshotForSession(
  dependencies: RuntimeXtermDependencies,
  sessionId: TerminalTabId,
): RuntimeTerminalSnapshot {
  const terminal = dependencies.terminalForSession(sessionId);
  return {
    sessionId,
    instanceId: terminal?.id ?? null,
    writeLog: [...(terminal?.writes ?? [])],
    mountHostDescriptions: [...(terminal?.mountHostDescriptions ?? [])],
    currentHostDescription: terminal?.currentHostDescription ?? null,
    currentHostArea: terminal?.currentHostArea ?? null,
    currentHostGroupId: terminal?.currentHostGroupId ?? null,
    focusCount: terminal?.focusCount ?? 0,
    fitCount: terminal?.fitCount ?? 0,
    detachCount: terminal?.detachCount ?? 0,
    disposeCount: terminal?.disposeCount ?? 0,
  };
}

class RuntimeXtermDependencies implements TerminalServiceXtermDependencies {
  public readonly terminals: RuntimeTerminal[] = [];

  public createTerminal(options: TerminalServiceTerminalCreateOptions): TerminalServiceTerminalLike {
    const terminal = new RuntimeTerminal(this.terminals.length + 1, options);
    this.terminals.push(terminal);
    return terminal;
  }

  public terminalForSession(sessionId: TerminalTabId): RuntimeTerminal | null {
    return this.terminals.find((terminal) => terminal.sessionIds.has(sessionId)) ?? null;
  }
}

class RuntimeTerminal implements TerminalServiceTerminalLike {
  public readonly sessionIds = new Set<TerminalTabId>();
  public readonly writes: string[] = [];
  public readonly mountHostDescriptions: string[] = [];
  public currentHostDescription: string | null = null;
  public currentHostArea: string | null = null;
  public currentHostGroupId: string | null = null;
  public focusCount = 0;
  public fitCount = 0;
  public detachCount = 0;
  public disposeCount = 0;
  private element: HTMLElement | null = null;
  private disposed = false;

  public constructor(
    public readonly id: number,
    private readonly options: TerminalServiceTerminalCreateOptions,
  ) {}

  public mount(parent: HTMLElement): boolean {
    if (this.disposed) {
      return false;
    }

    const sessionId = terminalSessionIdFromHost(parent);
    if (sessionId) {
      this.sessionIds.add(sessionId);
    }

    this.element ??= this.createElement();
    parent.append(this.element);
    const description = describeTerminalHost(parent);
    this.currentHostDescription = description.description;
    this.currentHostArea = description.area;
    this.currentHostGroupId = description.groupId;
    this.mountHostDescriptions.push(description.description);
    parent.dataset.runtimeTerminalInstanceId = String(this.id);
    this.element.dataset.runtimeTerminalHost = description.description;
    this.element.textContent = this.writes.join("");
    this.options.onResize({ cols: 120, rows: 30 });
    return true;
  }

  public detach(): void {
    this.detachCount += 1;
    this.currentHostDescription = null;
    this.currentHostArea = null;
    this.currentHostGroupId = null;
  }

  public fit(): void {
    this.fitCount += 1;
  }

  public focus(): void {
    this.focusCount += 1;
  }

  public write(data: string): void {
    this.writes.push(data);
    if (this.element) {
      this.element.textContent = this.writes.join("");
    }
  }

  public dispose(): void {
    this.disposeCount += 1;
    this.disposed = true;
    this.element?.remove();
    this.element = null;
  }

  private createElement(): HTMLElement {
    const element = document.createElement("section");
    element.dataset.component = "runtime-terminal-instance";
    element.dataset.runtimeTerminalInstanceId = String(this.id);
    element.className = "h-full min-h-0 whitespace-pre rounded border border-dashed border-border bg-background p-2 font-mono text-xs";
    return element;
  }
}

function terminalSessionIdFromHost(host: HTMLElement): TerminalTabId | null {
  return host.dataset.terminalTabId as TerminalTabId | undefined ?? null;
}

function describeTerminalHost(host: HTMLElement): { description: string; area: string | null; groupId: string | null } {
  const area = host.closest<HTMLElement>("[data-center-area]")?.dataset.centerArea ?? null;
  const groupId = host.closest<HTMLElement>("[data-editor-flexlayout-tab-content]")?.dataset.editorGroupId ?? null;
  const tabId = host.dataset.terminalTabId ?? "unknown-tab";
  const component = host.dataset.component ?? host.closest<HTMLElement>("[data-component]")?.dataset.component ?? "terminal-host";
  return {
    description: [area ?? "unknown-area", groupId ?? "no-group", component, tabId].join(":"),
    area,
    groupId,
  };
}

function installConsoleCapture(): void {
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    capturedErrors.push(args.map(stringifyErrorPart).join(" "));
    originalError(...args);
  };
  console.warn = (...args: unknown[]) => {
    const message = args.map(stringifyErrorPart).join(" ");
    if (suspiciousMessagePattern.test(message)) {
      capturedErrors.push(message);
    }
    originalWarn(...args);
  };
  window.addEventListener("error", (event) => {
    capturedErrors.push(stringifyErrorPart(event.error ?? event.message));
  });
  window.addEventListener("unhandledrejection", (event) => {
    capturedErrors.push(stringifyErrorPart(event.reason));
  });
}

function prepareDocument(rootElement: HTMLElement): void {
  rootElement.innerHTML = "";
  document.documentElement.style.width = "1280px";
  document.documentElement.style.height = "900px";
  document.body.style.width = "1280px";
  document.body.style.height = "900px";
  document.body.style.margin = "0";
  rootElement.style.width = "1280px";
  rootElement.style.height = "900px";
}

async function waitForSelector(selector: string, root: ParentNode = document, timeoutMs = 5_000): Promise<void> {
  await waitUntil(() => root.querySelector(selector) !== null, timeoutMs, () => `Timed out waiting for ${selector}`);
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, errorMessage: () => string): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await animationFrame();
  }
  throw new Error(errorMessage());
}

function animationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function publishResult(result: EditorTerminalDockRuntimeSmokeResult): void {
  window[RESULT_GLOBAL_NAME] = result;
}

function failedResult(reason: string): EditorTerminalDockRuntimeSmokeResult {
  return {
    ok: false,
    errors: [reason],
    scenarios: [],
    dockState: {
      bottomDetachedTerminalIds: [],
      bottomAttachedTerminalIds: [],
      editorTerminalTabIds: [],
      uniqueEditorTerminalTabIds: [],
      groupByTerminalId: {},
      groupsByTerminalId: {},
      centerMode: "unknown",
      activeCenterArea: "editor",
    },
    ptyEvidence: {
      alphaInstanceIdBeforeMove: null,
      alphaInstanceIdAfterMove: null,
      alphaSameInstanceAfterMove: false,
      alphaWriteLog: [],
      alphaDataEvents: [],
      betaWriteLog: [],
      terminalCreateCount: 0,
    },
    terminalSnapshots: [],
    reason,
  };
}

function stringifyErrorPart(value: unknown): string {
  if (value instanceof Error) {
    return `${value.message}\n${value.stack ?? ""}`;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

void runSmoke();
