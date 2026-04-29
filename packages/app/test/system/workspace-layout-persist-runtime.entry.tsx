import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useStore } from "zustand";

import "../../src/renderer/styles.css";
import { CenterWorkbenchView } from "../../src/renderer/components/CenterWorkbench";
import {
  DEFAULT_BOTTOM_PANEL_VIEWS,
  createBottomPanelService,
  type BottomPanelPosition,
  type BottomPanelServiceSnapshot,
  type BottomPanelServiceStore,
} from "../../src/renderer/services/bottom-panel-service";
import {
  DEFAULT_EDITOR_GROUP_ID,
  createEditorGroupsService,
  type EditorGroup,
  type EditorGroupTab,
  type EditorGroupsSerializedModel,
  type EditorGroupsServiceStore,
} from "../../src/renderer/services/editor-groups-service";
import {
  createWorkspaceService,
  getWorkspaceLayoutStorageKey,
  type WorkspaceLayoutSnapshot,
  type WorkspaceServiceStore,
} from "../../src/renderer/services/workspace-service";

const SWITCH_RESTORE_CYCLES = 5;
const RESTORE_TIMEOUT_MS = 5_000;
const WORKSPACES = [
  { id: "ws_layout_alpha", absolutePath: "/tmp/nexus-layout-alpha", displayName: "Alpha" },
  { id: "ws_layout_beta", absolutePath: "/tmp/nexus-layout-beta", displayName: "Beta" },
  { id: "ws_layout_gamma", absolutePath: "/tmp/nexus-layout-gamma", displayName: "Gamma" },
] as const;
const CORRUPT_WORKSPACE_ID = "ws_layout_corrupt";

interface WorkspaceRuntimeLayout extends WorkspaceLayoutSnapshot {
  schema: "workspace-layout-persist-runtime/v1";
  workspaceId: string;
  editorGroups: EditorGroupsSerializedModel;
  bottomPanel: BottomPanelServiceSnapshot;
}

interface WorkspaceLayoutPersistRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  registeredWorkspaceIds: string[];
  layoutSummaries: Array<{
    workspaceId: string;
    editorGroupCount: number;
    bottomPanelPosition: string;
    terminalInEditorArea: boolean;
  }>;
  restartPolicy: {
    workspaceId: string;
    persistedTerminalTabIds: string[];
    restoredTerminalTabIds: string[];
    groupIdsBeforeRestart: string[];
    groupIdsAfterRestart: string[];
    terminalTabsDropped: boolean;
    groupLayoutSurvives: boolean;
    bottomPanelSurvives: boolean;
  };
  localStorageKeys: Array<{
    workspaceId: string;
    key: string;
    exists: boolean;
    parsedMatchesExpected: boolean;
  }>;
  roundTrip: Array<{
    workspaceId: string;
    jsonLossless: boolean;
    workspaceServiceLossless: boolean;
    editorGroupsLossless: boolean;
    localStorageLossless: boolean;
  }>;
  switchRestore: {
    cycles: number;
    totalSwitches: number;
    exactRestoreCount: number;
    failures: string[];
  };
  corruptFallback: {
    didNotThrow: boolean;
    corruptLayoutIsNull: boolean;
    defaultEditorGroupRestored: boolean;
  };
  reason?: string;
}

interface RuntimeServices {
  workspaces: WorkspaceServiceStore;
  editorGroups: EditorGroupsServiceStore;
  bottomPanel: BottomPanelServiceStore;
}

interface RestoreCheck {
  cycle: number;
  workspaceId: string;
  exact: boolean;
  failures: string[];
}

declare global {
  interface Window {
    __nexusWorkspaceLayoutPersistRuntimeSmokeResult?: WorkspaceLayoutPersistRuntimeSmokeResult;
  }
}

const capturedErrors: string[] = [];
const suspiciousMessagePattern =
  /Maximum update depth exceeded|Cannot update a component|error boundary|uncaught|unhandled|getSnapshot should be cached|not wrapped in act|failed to restore workspace layout/i;
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);

console.error = (...args: unknown[]) => {
  capturedErrors.push(args.map(stringifyErrorPart).join(" "));
  originalConsoleError(...args);
};
console.warn = (...args: unknown[]) => {
  const message = args.map(stringifyErrorPart).join(" ");
  if (suspiciousMessagePattern.test(message)) {
    capturedErrors.push(message);
  }
  originalConsoleWarn(...args);
};
window.addEventListener("error", (event) => {
  capturedErrors.push(stringifyErrorPart(event.error ?? event.message));
});
window.addEventListener("unhandledrejection", (event) => {
  capturedErrors.push(stringifyErrorPart(event.reason));
});

void runSmoke();

async function runSmoke(): Promise<void> {
  let root: Root | null = null;
  let unsubscribeWorkspaceChanges: (() => void) | null = null;

  try {
    const rootElement = document.getElementById("app");
    if (!rootElement) {
      publishResult(failedResult("Missing #app root"));
      return;
    }

    prepareDocument(rootElement);
    clearWorkspaceLayoutStorage();

    const persistedLayouts = createExpectedWorkspaceLayouts();
    const restartLayouts = createRestartRestorableWorkspaceLayouts(persistedLayouts);
    const restartPolicy = collectRestartPolicyEvidence(persistedLayouts, restartLayouts);
    const writerWorkspaceService = createWorkspaceService();
    registerWorkspaces(writerWorkspaceService);
    for (const workspace of WORKSPACES) {
      writerWorkspaceService.getState().saveLayoutModel(workspace.id, persistedLayouts[workspace.id]);
    }

    const localStorageKeys = collectLocalStorageKeyEvidence(persistedLayouts);
    const roundTrip = collectRoundTripEvidence(persistedLayouts, writerWorkspaceService);
    const layoutSummaries = WORKSPACES.map((workspace) => summarizeLayout(restartLayouts[workspace.id]));
    const services = createRuntimeServices();
    registerWorkspaces(services.workspaces);
    applyActiveWorkspaceLayout(services);
    unsubscribeWorkspaceChanges = services.workspaces.getState().onWorkspaceChanged((snapshot) => {
      if (!snapshot.activeWorkspaceId) {
        return;
      }
      applyActiveWorkspaceLayout(services);
    });

    root = createRoot(rootElement);
    root.render(
      <StrictMode>
        <WorkspaceLayoutRuntimeHarness services={services} />
      </StrictMode>,
    );
    await waitForSelector('[data-fixture="workspace-layout-persist-runtime"]', rootElement, RESTORE_TIMEOUT_MS);

    const restoreChecks: RestoreCheck[] = [];
    for (let cycle = 1; cycle <= SWITCH_RESTORE_CYCLES; cycle += 1) {
      for (const workspace of WORKSPACES) {
        services.workspaces.getState().activateWorkspace(workspace.id);
        const persistedLayout = persistedLayouts[workspace.id];
        const restartLayout = restartLayouts[workspace.id];
        await waitForExactRestore(services, rootElement, persistedLayout, restartLayout);
        restoreChecks.push(collectRestoreCheck(cycle, services, rootElement, persistedLayout, restartLayout));
      }
    }

    const corruptFallback = verifyCorruptJsonFallback();
    const fatalErrors = capturedErrors.filter((message) => suspiciousMessagePattern.test(message));
    const switchRestoreFailures = restoreChecks.flatMap((check) => check.failures);
    const exactRestoreCount = restoreChecks.filter((check) => check.exact).length;
    const registeredWorkspaceIds = services.workspaces.getState().getOpenWorkspaces().map((workspace) => workspace.id);
    const ok =
      fatalErrors.length === 0 &&
      registeredWorkspaceIds.length === WORKSPACES.length &&
      layoutSummaries[0]?.editorGroupCount === 4 &&
      layoutSummaries[0]?.bottomPanelPosition === "bottom" &&
      layoutSummaries[1]?.editorGroupCount === 1 &&
      layoutSummaries[1]?.bottomPanelPosition === "right" &&
      layoutSummaries[2]?.editorGroupCount === 1 &&
      layoutSummaries[2]?.terminalInEditorArea === false &&
      restartPolicy.terminalTabsDropped &&
      restartPolicy.groupLayoutSurvives &&
      restartPolicy.bottomPanelSurvives &&
      localStorageKeys.every((entry) => entry.exists && entry.parsedMatchesExpected) &&
      roundTrip.every((entry) =>
        entry.jsonLossless &&
        entry.workspaceServiceLossless &&
        entry.editorGroupsLossless &&
        entry.localStorageLossless
      ) &&
      restoreChecks.length === WORKSPACES.length * SWITCH_RESTORE_CYCLES &&
      exactRestoreCount === restoreChecks.length &&
      switchRestoreFailures.length === 0 &&
      corruptFallback.didNotThrow &&
      corruptFallback.corruptLayoutIsNull &&
      corruptFallback.defaultEditorGroupRestored;

    root.unmount();
    root = null;
    unsubscribeWorkspaceChanges?.();
    unsubscribeWorkspaceChanges = null;

    publishResult({
      ok,
      errors: fatalErrors,
      registeredWorkspaceIds,
      layoutSummaries,
      restartPolicy,
      localStorageKeys,
      roundTrip,
      switchRestore: {
        cycles: SWITCH_RESTORE_CYCLES,
        totalSwitches: restoreChecks.length,
        exactRestoreCount,
        failures: switchRestoreFailures,
      },
      corruptFallback,
      reason:
        fatalErrors[0] ??
        (registeredWorkspaceIds.length !== WORKSPACES.length
          ? `Expected ${WORKSPACES.length} registered workspaces, saw ${registeredWorkspaceIds.length}`
          : undefined) ??
        (localStorageKeys.some((entry) => !entry.exists || !entry.parsedMatchesExpected)
          ? `Workspace layout localStorage key failed: ${JSON.stringify(localStorageKeys.find((entry) => !entry.exists || !entry.parsedMatchesExpected))}`
          : undefined) ??
        (!restartPolicy.terminalTabsDropped || !restartPolicy.groupLayoutSurvives || !restartPolicy.bottomPanelSurvives
          ? `Workspace restart terminal persistence policy failed: ${JSON.stringify(restartPolicy)}`
          : undefined) ??
        (roundTrip.some((entry) =>
          !entry.jsonLossless ||
          !entry.workspaceServiceLossless ||
          !entry.editorGroupsLossless ||
          !entry.localStorageLossless
        )
          ? `Workspace layout round-trip failed: ${JSON.stringify(roundTrip.find((entry) => !entry.jsonLossless || !entry.workspaceServiceLossless || !entry.editorGroupsLossless || !entry.localStorageLossless))}`
          : undefined) ??
        (switchRestoreFailures[0] ? `Workspace switch restore failed: ${switchRestoreFailures[0]}` : undefined) ??
        (!corruptFallback.didNotThrow || !corruptFallback.corruptLayoutIsNull || !corruptFallback.defaultEditorGroupRestored
          ? `Corrupt JSON fallback failed: ${JSON.stringify(corruptFallback)}`
          : undefined),
    });
  } catch (error) {
    root?.unmount();
    unsubscribeWorkspaceChanges?.();
    publishResult(failedResult(stringifyErrorPart(error)));
  }
}

function WorkspaceLayoutRuntimeHarness({ services }: { services: RuntimeServices }): JSX.Element {
  const openWorkspaces = useStore(services.workspaces, (state) => state.openWorkspaces);
  const activeWorkspaceId = useStore(services.workspaces, (state) => state.activeWorkspaceId);
  const groups = useStore(services.editorGroups, (state) => state.groups);
  const activeGroupId = useStore(services.editorGroups, (state) => state.activeGroupId);
  const bottomPanelViews = useStore(services.bottomPanel, (state) => state.views);
  const bottomPanelActiveViewId = useStore(services.bottomPanel, (state) => state.activeViewId);
  const bottomPanelPosition = useStore(services.bottomPanel, (state) => state.position);
  const bottomPanelExpanded = useStore(services.bottomPanel, (state) => state.expanded);
  const bottomPanelHeight = useStore(services.bottomPanel, (state) => state.height);

  return (
    <div
      data-fixture="workspace-layout-persist-runtime"
      data-active-workspace-id={activeWorkspaceId ?? ""}
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      <nav data-component="workspace-registration-strip" className="flex h-9 shrink-0 gap-1 border-b border-border px-2 py-1">
        {openWorkspaces.map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            data-workspace-id={workspace.id}
            data-active={workspace.id === activeWorkspaceId ? "true" : "false"}
            className="rounded border border-border px-2 text-xs"
            onClick={() => services.workspaces.getState().activateWorkspace(workspace.id)}
          >
            {workspace.displayName}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1">
        <CenterWorkbenchView
          editorArea={<RuntimeEditorGrid groups={groups} activeGroupId={activeGroupId} />}
          bottomPanel={
            <RuntimeBottomPanel
              views={bottomPanelViews}
              activeViewId={bottomPanelActiveViewId}
              position={bottomPanelPosition}
              expanded={bottomPanelExpanded}
              onActiveViewChange={(viewId) => services.bottomPanel.getState().setActiveView(viewId)}
            />
          }
          bottomPanelPosition={bottomPanelPosition}
          bottomPanelExpanded={bottomPanelExpanded}
          bottomPanelSize={bottomPanelHeight}
          activeArea="editor"
          onBottomPanelSizeChange={(size) => services.bottomPanel.getState().setHeight(size)}
        />
      </div>
    </div>
  );
}

function RuntimeEditorGrid({ groups, activeGroupId }: { groups: readonly EditorGroup[]; activeGroupId: string | null }): JSX.Element {
  return (
    <section
      data-component="editor-groups-part"
      data-editor-grid-provider="flexlayout-model"
      data-editor-grid-capacity="6"
      data-editor-groups-serializable="true"
      data-active-editor-group-id={activeGroupId ?? ""}
      className="grid h-full min-h-0 grid-cols-2 gap-2 p-2"
    >
      {Array.from({ length: 6 }, (_, index) => {
        const group = groups[index] ?? null;
        return (
          <section
            key={index + 1}
            data-editor-grid-slot={index + 1}
            data-editor-group-id={group?.id ?? ""}
            data-editor-group-tab-count={group?.tabs.length ?? 0}
            data-editor-group-active-tab-id={group?.activeTabId ?? ""}
            data-editor-group-terminal-ready="true"
            className="min-h-0 rounded border border-border bg-card/40 p-2 text-xs"
          >
            <div data-editor-grid-slot-label="true">Slot {index + 1}</div>
            {group?.tabs.map((tab) => (
              <div
                key={tab.id}
                data-editor-group-tab-id={tab.id}
                data-editor-group-tab-kind={tab.kind}
                data-editor-group-tab-workspace-id={tab.workspaceId ?? ""}
                data-active={tab.id === group.activeTabId ? "true" : "false"}
              >
                {tab.title}
              </div>
            ))}
          </section>
        );
      })}
    </section>
  );
}

function RuntimeBottomPanel({
  views,
  activeViewId,
  position,
  expanded,
  onActiveViewChange,
}: {
  views: Array<{ id: string; label: string }>;
  activeViewId: string | null;
  position: BottomPanelPosition;
  expanded: boolean;
  onActiveViewChange(viewId: string): void;
}): JSX.Element {
  const resolvedActiveViewId = activeViewId && views.some((view) => view.id === activeViewId)
    ? activeViewId
    : views[0]?.id ?? null;

  return (
    <section
      data-component="bottom-panel"
      data-bottom-panel-position={position}
      data-bottom-panel-expanded={expanded ? "true" : "false"}
      data-bottom-panel-active-view={resolvedActiveViewId ?? ""}
      className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <div role="tablist" aria-label="Runtime bottom panel views" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {views.map((view) => (
            <button
              key={view.id}
              type="button"
              role="tab"
              data-action="bottom-panel-select-view"
              data-bottom-panel-view={view.id}
              data-active={view.id === resolvedActiveViewId ? "true" : "false"}
              aria-selected={view.id === resolvedActiveViewId}
              className="rounded px-2 text-xs"
              onClick={() => onActiveViewChange(view.id)}
            >
              {view.label}
            </button>
          ))}
        </div>
        <div data-bottom-panel-dock-zone="true" data-bottom-panel-dock-positions="left right top bottom">
          {position}
        </div>
      </header>
      <div className="min-h-0 flex-1 p-3 text-xs" data-bottom-panel-runtime-content={resolvedActiveViewId ?? ""}>
        {resolvedActiveViewId ? `${resolvedActiveViewId} panel for persisted layout` : "No active bottom panel"}
      </div>
    </section>
  );
}

function createExpectedWorkspaceLayouts(): Record<string, WorkspaceRuntimeLayout> {
  const [alpha, beta, gamma] = WORKSPACES;

  return {
    [alpha.id]: createWorkspaceRuntimeLayout(
      alpha.id,
      createEditorLayoutFromGroups([
        createEditorGroup(alpha.id, "alpha_group_1", [createFileTab(alpha.id, "alpha_one.ts")]),
        createEditorGroup(alpha.id, "alpha_group_2", [createFileTab(alpha.id, "alpha_two.ts")]),
        createEditorGroup(alpha.id, "alpha_group_3", [createFileTab(alpha.id, "alpha_three.ts")]),
        createEditorGroup(alpha.id, "alpha_group_4", [createFileTab(alpha.id, "alpha_four.ts")]),
      ], "alpha_group_1"),
      createBottomPanelSnapshot("bottom", 320),
    ),
    [beta.id]: createWorkspaceRuntimeLayout(
      beta.id,
      createEditorLayoutFromGroups([
        createEditorGroup(beta.id, "beta_group_main", [createFileTab(beta.id, "beta_single.ts")]),
      ], "beta_group_main"),
      createBottomPanelSnapshot("right", 280),
    ),
    [gamma.id]: createWorkspaceRuntimeLayout(
      gamma.id,
      createEditorLayoutFromGroups([
        createEditorGroup(gamma.id, "gamma_group_terminal", [createTerminalTab(gamma.id, "gamma_terminal")]),
      ], "gamma_group_terminal"),
      createBottomPanelSnapshot("bottom", 240),
    ),
  };
}

function createWorkspaceRuntimeLayout(
  workspaceId: string,
  editorGroups: EditorGroupsSerializedModel,
  bottomPanel: BottomPanelServiceSnapshot,
): WorkspaceRuntimeLayout {
  return {
    schema: "workspace-layout-persist-runtime/v1",
    workspaceId,
    editorGroups,
    bottomPanel,
  };
}

function createRestartRestorableWorkspaceLayouts(
  layouts: Record<string, WorkspaceRuntimeLayout>,
): Record<string, WorkspaceRuntimeLayout> {
  return Object.fromEntries(
    Object.entries(layouts).map(([workspaceId, layout]) => [
      workspaceId,
      createRestartRestorableWorkspaceLayout(layout),
    ]),
  );
}

function createRestartRestorableWorkspaceLayout(layout: WorkspaceRuntimeLayout): WorkspaceRuntimeLayout {
  const editorGroups = createEditorGroupsService({
    layoutSnapshot: dropTerminalTabsFromEditorGroupsModel(layout.editorGroups),
  }).getState().serializeModel();

  return {
    ...layout,
    editorGroups,
  };
}

function collectRestartPolicyEvidence(
  persistedLayouts: Record<string, WorkspaceRuntimeLayout>,
  restartLayouts: Record<string, WorkspaceRuntimeLayout>,
): WorkspaceLayoutPersistRuntimeSmokeResult["restartPolicy"] {
  const workspaceId = "ws_layout_gamma";
  const persistedLayout = persistedLayouts[workspaceId];
  const restartLayout = restartLayouts[workspaceId];
  const persistedTerminalTabIds = terminalTabIdsFromLayout(persistedLayout.editorGroups);
  const restoredTerminalTabIds = terminalTabIdsFromLayout(restartLayout.editorGroups);
  const groupIdsBeforeRestart = groupIdsFromLayout(persistedLayout.editorGroups);
  const groupIdsAfterRestart = groupIdsFromLayout(restartLayout.editorGroups);

  return {
    workspaceId,
    persistedTerminalTabIds,
    restoredTerminalTabIds,
    groupIdsBeforeRestart,
    groupIdsAfterRestart,
    terminalTabsDropped: persistedTerminalTabIds.length > 0 && restoredTerminalTabIds.length === 0,
    groupLayoutSurvives: sameJson(groupIdsAfterRestart, groupIdsBeforeRestart),
    bottomPanelSurvives: bottomPanelSnapshotsMatch(restartLayout.bottomPanel, persistedLayout.bottomPanel),
  };
}

function dropTerminalTabsFromEditorGroupsModel(model: EditorGroupsSerializedModel): EditorGroupsSerializedModel {
  const cloned = safeJsonParse(JSON.stringify(model));
  if (!isRecord(cloned)) {
    return model;
  }

  const layout = isRecord(cloned.layout) ? pruneTerminalTabsFromLayoutNode(cloned.layout) : cloned.layout;
  return {
    ...cloned,
    layout: isRecord(layout) ? layout : cloned.layout,
  } as unknown as EditorGroupsSerializedModel;
}

function pruneTerminalTabsFromLayoutNode(node: Record<string, unknown>): Record<string, unknown> | null {
  if (isTerminalSerializedTabNode(node)) {
    return null;
  }

  const nextNode: Record<string, unknown> = { ...node };
  if (Array.isArray(node.children)) {
    const children = node.children
      .map((child) => isRecord(child) ? pruneTerminalTabsFromLayoutNode(child) : child)
      .filter((child): child is unknown => child !== null);
    nextNode.children = children;

    if (node.type === "tabset") {
      const selected = typeof node.selected === "number" ? node.selected : -1;
      nextNode.selected = children.length > 0 ? Math.min(Math.max(0, selected), children.length - 1) : -1;
    }
  }

  return nextNode;
}

function isTerminalSerializedTabNode(node: Record<string, unknown>): boolean {
  if (node.type !== "tab" || !isRecord(node.config) || !isRecord(node.config.editorGroupTab)) {
    return false;
  }

  return node.config.editorGroupTab.kind === "terminal";
}

function createEditorLayoutFromGroups(groups: EditorGroup[], activeGroupId: string): EditorGroupsSerializedModel {
  const store = createEditorGroupsService({ groups, activeGroupId });
  return store.getState().serializeModel();
}

function createEditorGroup(workspaceId: string, groupId: string, tabs: EditorGroupTab[]): EditorGroup {
  return {
    id: groupId,
    tabs: tabs.map((tab) => ({ ...tab, workspaceId })),
    activeTabId: tabs[0]?.id ?? null,
  };
}

function createFileTab(workspaceId: string, title: string): EditorGroupTab {
  const normalizedTitle = title.replace(/[^a-zA-Z0-9]/g, "_");

  return {
    id: `tab_${workspaceId}_${normalizedTitle}`,
    title,
    kind: "file",
    workspaceId,
    resourcePath: `src/${title}`,
  };
}

function createTerminalTab(workspaceId: string, terminalId: string): EditorGroupTab {
  return {
    id: `terminal_${workspaceId}_${terminalId}`,
    title: "Terminal",
    kind: "terminal",
    workspaceId,
    resourcePath: null,
  };
}

function createBottomPanelSnapshot(position: BottomPanelPosition, height: number): BottomPanelServiceSnapshot {
  return createBottomPanelService({
    views: DEFAULT_BOTTOM_PANEL_VIEWS,
    activeViewId: "terminal",
    position,
    expanded: true,
    height,
  }).getState().getSnapshot();
}

function createRuntimeServices(): RuntimeServices {
  return {
    workspaces: createWorkspaceService(),
    editorGroups: createEditorGroupsService(),
    bottomPanel: createBottomPanelService(),
  };
}

function registerWorkspaces(workspaceService: WorkspaceServiceStore): void {
  for (const workspace of WORKSPACES) {
    workspaceService.getState().openWorkspace(workspace);
  }
}

function applyActiveWorkspaceLayout(services: RuntimeServices): void {
  const activeWorkspaceId = services.workspaces.getState().activeWorkspaceId;
  const persistedLayout = activeWorkspaceId
    ? asWorkspaceRuntimeLayout(services.workspaces.getState().getLayoutModel(activeWorkspaceId))
    : null;
  const layout = persistedLayout ? createRestartRestorableWorkspaceLayout(persistedLayout) : null;

  if (!layout) {
    return;
  }

  services.editorGroups.getState().deserializeModel(layout.editorGroups);
  services.bottomPanel.getState().setPosition(layout.bottomPanel.position);
  services.bottomPanel.getState().setHeight(layout.bottomPanel.height, layout.bottomPanel.heightPersistenceKey);
  services.bottomPanel.getState().setActiveView(layout.bottomPanel.activeViewId ?? "terminal");
  services.bottomPanel.getState().setExpanded(layout.bottomPanel.expanded);
}

async function waitForExactRestore(
  services: RuntimeServices,
  rootElement: HTMLElement,
  expectedPersistedLayout: WorkspaceRuntimeLayout,
  expectedRuntimeLayout: WorkspaceRuntimeLayout,
): Promise<void> {
  await waitUntil(() => {
    return collectRestoreCheck(0, services, rootElement, expectedPersistedLayout, expectedRuntimeLayout).exact;
  }, RESTORE_TIMEOUT_MS, () => {
    const check = collectRestoreCheck(0, services, rootElement, expectedPersistedLayout, expectedRuntimeLayout);
    return `Timed out waiting for exact restore of ${expectedRuntimeLayout.workspaceId}: ${check.failures.join("; ")}`;
  });
}

function collectRestoreCheck(
  cycle: number,
  services: RuntimeServices,
  rootElement: HTMLElement,
  expectedPersistedLayout: WorkspaceRuntimeLayout,
  expectedRuntimeLayout: WorkspaceRuntimeLayout,
): RestoreCheck {
  const failures: string[] = [];
  const actualActiveWorkspaceId = services.workspaces.getState().activeWorkspaceId;
  const persistedLayout = actualActiveWorkspaceId
    ? services.workspaces.getState().getLayoutModel(actualActiveWorkspaceId)
    : null;
  const actualEditorGroups = services.editorGroups.getState().serializeModel();
  const bottomPanelSnapshot = services.bottomPanel.getState().getSnapshot();
  const fixture = rootElement.querySelector<HTMLElement>('[data-fixture="workspace-layout-persist-runtime"]');
  const centerWorkbench = rootElement.querySelector<HTMLElement>('[data-component="center-workbench"]');
  const bottomPanel = rootElement.querySelector<HTMLElement>('[data-component="bottom-panel"]');
  const editorGroupSlots = rootElement.querySelectorAll<HTMLElement>("[data-editor-grid-slot]");
  const terminalTab = rootElement.querySelector<HTMLElement>('[data-editor-group-tab-kind="terminal"]');
  const layoutSummary = summarizeLayout(expectedRuntimeLayout);

  if (actualActiveWorkspaceId !== expectedRuntimeLayout.workspaceId) {
    failures.push(`active workspace ${actualActiveWorkspaceId ?? "null"} != ${expectedRuntimeLayout.workspaceId}`);
  }
  if (fixture?.dataset.activeWorkspaceId !== expectedRuntimeLayout.workspaceId) {
    failures.push(`DOM active workspace ${fixture?.dataset.activeWorkspaceId ?? "missing"} != ${expectedRuntimeLayout.workspaceId}`);
  }
  if (!sameJson(persistedLayout, expectedPersistedLayout)) {
    failures.push("persisted workspace layout did not equal expected layout");
  }
  if (!sameJson(actualEditorGroups, expectedRuntimeLayout.editorGroups)) {
    failures.push("editor groups serialized model did not equal restart-restorable layout");
  }
  if (!bottomPanelSnapshotsMatch(bottomPanelSnapshot, expectedRuntimeLayout.bottomPanel)) {
    failures.push(`bottom panel snapshot ${bottomPanelSnapshot.position}/${bottomPanelSnapshot.height} did not equal expected ${expectedRuntimeLayout.bottomPanel.position}/${expectedRuntimeLayout.bottomPanel.height}`);
  }
  if (centerWorkbench?.dataset.bottomPanelPosition !== expectedRuntimeLayout.bottomPanel.position) {
    failures.push(`CenterWorkbench bottom panel DOM position ${centerWorkbench?.dataset.bottomPanelPosition ?? "missing"} != ${expectedRuntimeLayout.bottomPanel.position}`);
  }
  if (bottomPanel?.dataset.bottomPanelPosition !== expectedRuntimeLayout.bottomPanel.position) {
    failures.push(`BottomPanel DOM position ${bottomPanel?.dataset.bottomPanelPosition ?? "missing"} != ${expectedRuntimeLayout.bottomPanel.position}`);
  }
  if (editorGroupSlots.length !== 6) {
    failures.push(`expected 6 editor grid slots, saw ${editorGroupSlots.length}`);
  }
  if (countMaterializedEditorSlots(rootElement) !== layoutSummary.editorGroupCount) {
    failures.push(`expected ${layoutSummary.editorGroupCount} materialized editor slots, saw ${countMaterializedEditorSlots(rootElement)}`);
  }
  if (layoutSummary.terminalInEditorArea && terminalTab?.dataset.editorGroupTabWorkspaceId !== expectedRuntimeLayout.workspaceId) {
    failures.push("terminal tab was not restored into the active workspace editor area");
  }
  if (!layoutSummary.terminalInEditorArea && terminalTab) {
    failures.push("unexpected terminal tab appeared in non-terminal editor layout");
  }

  return {
    cycle,
    workspaceId: expectedRuntimeLayout.workspaceId,
    exact: failures.length === 0,
    failures,
  };
}

function bottomPanelSnapshotsMatch(actual: BottomPanelServiceSnapshot, expected: BottomPanelServiceSnapshot): boolean {
  return actual.activeViewId === expected.activeViewId &&
    actual.position === expected.position &&
    actual.expanded === expected.expanded &&
    actual.height === expected.height &&
    sameJson(actual.views, expected.views) &&
    sameJson(actual.heightByPersistenceKey, expected.heightByPersistenceKey);
}

function collectLocalStorageKeyEvidence(
  expectedLayouts: Record<string, WorkspaceRuntimeLayout>,
): WorkspaceLayoutPersistRuntimeSmokeResult["localStorageKeys"] {
  return WORKSPACES.map((workspace) => {
    const key = getWorkspaceLayoutStorageKey(workspace.id);
    const serialized = localStorage.getItem(key);
    const parsed = safeJsonParse(serialized);

    return {
      workspaceId: workspace.id,
      key,
      exists: serialized !== null,
      parsedMatchesExpected: sameJson(parsed, expectedLayouts[workspace.id]),
    };
  });
}

function collectRoundTripEvidence(
  expectedLayouts: Record<string, WorkspaceRuntimeLayout>,
  writerWorkspaceService: WorkspaceServiceStore,
): WorkspaceLayoutPersistRuntimeSmokeResult["roundTrip"] {
  return WORKSPACES.map((workspace) => {
    const expectedLayout = expectedLayouts[workspace.id];
    const jsonRoundTrip = safeJsonParse(JSON.stringify(expectedLayout));
    const storageRoundTrip = safeJsonParse(localStorage.getItem(getWorkspaceLayoutStorageKey(workspace.id)));
    const restoredEditorGroups = createEditorGroupsService();
    restoredEditorGroups.getState().deserializeModel(expectedLayout.editorGroups);

    return {
      workspaceId: workspace.id,
      jsonLossless: sameJson(jsonRoundTrip, expectedLayout),
      workspaceServiceLossless: sameJson(writerWorkspaceService.getState().getLayoutModel(workspace.id), expectedLayout),
      editorGroupsLossless: sameJson(restoredEditorGroups.getState().serializeModel(), expectedLayout.editorGroups),
      localStorageLossless: sameJson(storageRoundTrip, expectedLayout),
    };
  });
}

function summarizeLayout(layout: WorkspaceRuntimeLayout): WorkspaceLayoutPersistRuntimeSmokeResult["layoutSummaries"][number] {
  const inspector = createEditorGroupsService();
  inspector.getState().deserializeModel(layout.editorGroups);
  const groups = inspector.getState().groups;

  return {
    workspaceId: layout.workspaceId,
    editorGroupCount: groups.length,
    bottomPanelPosition: layout.bottomPanel.position,
    terminalInEditorArea: groups.some((group) => group.tabs.some((tab) => tab.kind === "terminal")),
  };
}

function terminalTabIdsFromLayout(layout: EditorGroupsSerializedModel): string[] {
  const inspector = createEditorGroupsService();
  inspector.getState().deserializeModel(layout);
  return inspector.getState().groups.flatMap((group) =>
    group.tabs.filter((tab) => tab.kind === "terminal").map((tab) => tab.id)
  );
}

function groupIdsFromLayout(layout: EditorGroupsSerializedModel): string[] {
  const inspector = createEditorGroupsService();
  inspector.getState().deserializeModel(layout);
  return inspector.getState().groups.map((group) => group.id);
}

function verifyCorruptJsonFallback(): WorkspaceLayoutPersistRuntimeSmokeResult["corruptFallback"] {
  const corruptKey = getWorkspaceLayoutStorageKey(CORRUPT_WORKSPACE_ID);
  let didNotThrow = true;
  let corruptLayout: WorkspaceLayoutSnapshot | null = null;
  let defaultEditorGroupRestored = false;

  try {
    localStorage.setItem(corruptKey, "{not-json");
    const corruptWorkspaceService = createWorkspaceService({
      openWorkspaces: [{
        id: CORRUPT_WORKSPACE_ID,
        absolutePath: "/tmp/nexus-layout-corrupt",
        displayName: "Corrupt",
      }],
      activeWorkspaceId: CORRUPT_WORKSPACE_ID,
    });
    corruptLayout = corruptWorkspaceService.getState().getLayoutModel(CORRUPT_WORKSPACE_ID);
    const defaultEditorGroups = createEditorGroupsService();
    defaultEditorGroupRestored = defaultEditorGroups.getState().groups[0]?.id === DEFAULT_EDITOR_GROUP_ID &&
      defaultEditorGroups.getState().groups.length === 1;
  } catch {
    didNotThrow = false;
  } finally {
    localStorage.removeItem(corruptKey);
  }

  return {
    didNotThrow,
    corruptLayoutIsNull: corruptLayout === null,
    defaultEditorGroupRestored,
  };
}

function asWorkspaceRuntimeLayout(layout: WorkspaceLayoutSnapshot | null): WorkspaceRuntimeLayout | null {
  if (!isRecord(layout) || layout.schema !== "workspace-layout-persist-runtime/v1") {
    return null;
  }
  if (typeof layout.workspaceId !== "string" || !isRecord(layout.editorGroups) || !isRecord(layout.bottomPanel)) {
    return null;
  }

  return layout as unknown as WorkspaceRuntimeLayout;
}

function countMaterializedEditorSlots(root: ParentNode): number {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-editor-grid-slot]"))
    .filter((element) => (element.dataset.editorGroupId ?? "").length > 0)
    .length;
}

function clearWorkspaceLayoutStorage(): void {
  for (const workspace of WORKSPACES) {
    localStorage.removeItem(getWorkspaceLayoutStorageKey(workspace.id));
  }
  localStorage.removeItem(getWorkspaceLayoutStorageKey(CORRUPT_WORKSPACE_ID));
}

function prepareDocument(rootElement: HTMLElement): void {
  document.documentElement.style.width = "1200px";
  document.documentElement.style.height = "900px";
  document.body.style.width = "1200px";
  document.body.style.height = "900px";
  document.body.style.margin = "0";
  rootElement.style.width = "1200px";
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

function safeJsonParse(serialized: string | null): unknown {
  if (serialized === null) {
    return null;
  }

  try {
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableClone(value));
}

function stableClone(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableClone);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableClone(value[key])]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failedResult(reason: string): WorkspaceLayoutPersistRuntimeSmokeResult {
  return {
    ok: false,
    errors: [reason],
    registeredWorkspaceIds: [],
    layoutSummaries: [],
    restartPolicy: {
      workspaceId: "ws_layout_gamma",
      persistedTerminalTabIds: [],
      restoredTerminalTabIds: [],
      groupIdsBeforeRestart: [],
      groupIdsAfterRestart: [],
      terminalTabsDropped: false,
      groupLayoutSurvives: false,
      bottomPanelSurvives: false,
    },
    localStorageKeys: [],
    roundTrip: [],
    switchRestore: {
      cycles: SWITCH_RESTORE_CYCLES,
      totalSwitches: 0,
      exactRestoreCount: 0,
      failures: [reason],
    },
    corruptFallback: {
      didNotThrow: false,
      corruptLayoutIsNull: false,
      defaultEditorGroupRestored: false,
    },
    reason,
  };
}

function publishResult(result: WorkspaceLayoutPersistRuntimeSmokeResult): void {
  window.__nexusWorkspaceLayoutPersistRuntimeSmokeResult = result;
}

function stringifyErrorPart(part: unknown): string {
  if (part instanceof Error) {
    return part.stack ?? part.message;
  }

  if (typeof part === "string") {
    return part;
  }

  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}
