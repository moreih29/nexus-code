import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Actions, Layout, type IJsonRect, type IJsonRowNode, type TabNode } from "flexlayout-react";
import { useStore } from "zustand";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import type { OpenSessionWorkspace } from "../../../shared/src/contracts/workspace/workspace-shell";
import "../../src/renderer/styles.css";
import "../../src/renderer/parts/editor-groups/flexlayout-theme.css";
import {
  DEFAULT_EDITOR_GROUP_ID,
  EDITOR_GROUP_TAB_COMPONENT,
  createEditorGroupsService,
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

const WORKSPACE_A_ID = "ws_floating_workspace_a" as WorkspaceId;
const WORKSPACE_B_ID = "ws_floating_workspace_b" as WorkspaceId;
const WORKSPACES: OpenSessionWorkspace[] = [
  {
    id: WORKSPACE_A_ID,
    displayName: "Floating Workspace A",
    absolutePath: "/tmp/nexus-floating-workspace-a",
  },
  {
    id: WORKSPACE_B_ID,
    displayName: "Floating Workspace B",
    absolutePath: "/tmp/nexus-floating-workspace-b",
  },
];
const FLOATING_TAB_ID = "tab_workspace_a_floating";
const WORKSPACE_A_DOCKED_TAB_ID = "tab_workspace_a_docked";
const WORKSPACE_B_DOCKED_TAB_ID = "tab_workspace_b_docked";
const FLOATING_RECT: IJsonRect = {
  x: 144,
  y: 96,
  width: 420,
  height: 260,
};
const SMOKE_TIMEOUT_MS = 10_000;

interface FloatingPanelGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface FloatingWorkspaceRuntimeLayout extends WorkspaceLayoutSnapshot {
  schema: "floating-workspace-runtime/v1";
  workspaceId: string;
  editorGroups: EditorGroupsSerializedModel;
}

interface WorkspaceRuntime {
  workspace: OpenSessionWorkspace;
  editorGroups: EditorGroupsServiceStore;
}

interface RuntimeServices {
  workspaces: WorkspaceServiceStore;
  runtimes: WorkspaceRuntime[];
}

interface FloatingWorkspaceRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  workspaceSwitch: {
    createdInWorkspaceId: string;
    switchedToWorkspaceId: string;
    returnedToWorkspaceId: string;
    activeWorkspaceSequence: string[];
  };
  hiddenNotUnmounted: {
    floatingNodeExistedBeforeSwitch: boolean;
    floatingNodeExistedWhileWorkspaceBActive: boolean;
    sameFloatingNodeWhileWorkspaceBActive: boolean;
    sameFloatingNodeAfterReturn: boolean;
    hiddenWhileWorkspaceBActive: boolean;
    hiddenMode: string;
  };
  geometryRestore: {
    beforeSwitch: FloatingPanelGeometry | null;
    afterReturn: FloatingPanelGeometry | null;
    deltaPx: FloatingPanelGeometry | null;
    deltaIsZero: boolean;
  };
  localStorageScope: {
    expectedKeys: string[];
    observedLayoutKeys: string[];
    onlyWorkspaceScopedKeys: boolean;
    entries: Array<{
      workspaceId: string;
      key: string;
      exists: boolean;
      hasEditorGroupsTree: boolean;
      floatingSubLayoutCount: number;
      floatingTabIds: string[];
      floatingRects: FloatingPanelGeometry[];
      includesFloatingState: boolean;
      containsOtherWorkspaceFloatingTab: boolean;
    }>;
  };
  reason?: string;
}

declare global {
  interface Window {
    __nexusFloatingWorkspaceRuntimeSmokeResult?: FloatingWorkspaceRuntimeSmokeResult;
  }
}

const capturedErrors: string[] = [];
const suspiciousMessagePattern =
  /Maximum update depth exceeded|Cannot update a component|error boundary|uncaught|unhandled|getSnapshot should be cached|not wrapped in act|Could not create web worker|MonacoEnvironment\.getWorker|MonacoEnvironment\.getWorkerUrl|worker_file|ts\.worker|json\.worker|Falling back to loading web worker code in main thread|Uncaught \[object Event\]|Uncaught Event/i;

installConsoleCapture();
void runSmoke();

async function runSmoke(): Promise<void> {
  let root: Root | null = null;

  try {
    const rootElement = document.getElementById("app");
    if (!rootElement) {
      publishResult(failedResult("Missing #app root"));
      return;
    }

    prepareDocument(rootElement);
    clearWorkspaceLayoutStorage();

    const services = createRuntimeServices();
    persistAllWorkspaceLayouts(services);

    root = createRoot(rootElement);
    root.render(
      <StrictMode>
        <FloatingWorkspaceRuntimeHarness services={services} />
      </StrictMode>,
    );

    await waitForSelector('[data-fixture="floating-workspace-runtime"]', rootElement, SMOKE_TIMEOUT_MS);
    await waitForSelector('[data-floating-workspace-host][data-workspace-id="ws_floating_workspace_a"][data-active="true"]', rootElement, SMOKE_TIMEOUT_MS);
    const beforeSwitchNode = await waitForFloatingWindow(WORKSPACE_A_ID, SMOKE_TIMEOUT_MS);
    const beforeSwitchGeometry = readGeometry(beforeSwitchNode);

    services.workspaces.getState().activateWorkspace(WORKSPACE_B_ID);
    await waitUntil(
      () => activeWorkspaceId(rootElement) === WORKSPACE_B_ID,
      SMOKE_TIMEOUT_MS,
      () => `Timed out switching to workspace B; active=${activeWorkspaceId(rootElement) ?? "<none>"}`,
    );
    persistAllWorkspaceLayouts(services);

    const whileWorkspaceBNode = findFloatingWindow(WORKSPACE_A_ID);
    const hiddenWhileWorkspaceBActive = whileWorkspaceBNode ? isVisuallyHidden(whileWorkspaceBNode) : false;
    const hiddenMode = whileWorkspaceBNode ? hiddenModeFor(whileWorkspaceBNode) : "missing";

    services.workspaces.getState().activateWorkspace(WORKSPACE_A_ID);
    await waitUntil(
      () => activeWorkspaceId(rootElement) === WORKSPACE_A_ID,
      SMOKE_TIMEOUT_MS,
      () => `Timed out switching back to workspace A; active=${activeWorkspaceId(rootElement) ?? "<none>"}`,
    );
    persistAllWorkspaceLayouts(services);

    const afterReturnNode = findFloatingWindow(WORKSPACE_A_ID);
    const afterReturnGeometry = afterReturnNode ? readGeometry(afterReturnNode) : null;
    const deltaPx = beforeSwitchGeometry && afterReturnGeometry
      ? deltaGeometry(beforeSwitchGeometry, afterReturnGeometry)
      : null;
    const localStorageScope = collectLocalStorageScopeEvidence();
    const fatalErrors = capturedErrors.filter((message) => suspiciousMessagePattern.test(message));
    const activeWorkspaceSequence = [WORKSPACE_A_ID, WORKSPACE_B_ID, WORKSPACE_A_ID];
    const hiddenNotUnmounted = {
      floatingNodeExistedBeforeSwitch: beforeSwitchNode !== null,
      floatingNodeExistedWhileWorkspaceBActive: whileWorkspaceBNode !== null,
      sameFloatingNodeWhileWorkspaceBActive: whileWorkspaceBNode === beforeSwitchNode,
      sameFloatingNodeAfterReturn: afterReturnNode === beforeSwitchNode,
      hiddenWhileWorkspaceBActive,
      hiddenMode,
    };
    const geometryRestore = {
      beforeSwitch: beforeSwitchGeometry,
      afterReturn: afterReturnGeometry,
      deltaPx,
      deltaIsZero: isZeroDelta(deltaPx),
    };
    const workspaceSwitch = {
      createdInWorkspaceId: WORKSPACE_A_ID,
      switchedToWorkspaceId: WORKSPACE_B_ID,
      returnedToWorkspaceId: WORKSPACE_A_ID,
      activeWorkspaceSequence,
    };
    const ok = fatalErrors.length === 0 &&
      hiddenNotUnmounted.floatingNodeExistedBeforeSwitch &&
      hiddenNotUnmounted.floatingNodeExistedWhileWorkspaceBActive &&
      hiddenNotUnmounted.sameFloatingNodeWhileWorkspaceBActive &&
      hiddenNotUnmounted.sameFloatingNodeAfterReturn &&
      hiddenNotUnmounted.hiddenWhileWorkspaceBActive &&
      hiddenNotUnmounted.hiddenMode === "visibility:hidden" &&
      geometryRestore.deltaIsZero &&
      localStorageScope.onlyWorkspaceScopedKeys &&
      localStorageScope.observedLayoutKeys.join("|") === localStorageScope.expectedKeys.join("|") &&
      localStorageScope.entries[0]?.includesFloatingState === true &&
      localStorageScope.entries[0]?.floatingSubLayoutCount === 1 &&
      localStorageScope.entries[0]?.floatingTabIds.includes(FLOATING_TAB_ID) === true &&
      localStorageScope.entries.every((entry) => entry.exists && entry.hasEditorGroupsTree && !entry.containsOtherWorkspaceFloatingTab);

    root.unmount();
    root = null;

    publishResult({
      ok,
      errors: fatalErrors,
      workspaceSwitch,
      hiddenNotUnmounted,
      geometryRestore,
      localStorageScope,
      reason:
        fatalErrors[0] ??
        (!hiddenNotUnmounted.floatingNodeExistedBeforeSwitch
          ? "Workspace A floating panel did not mount before the workspace switch."
          : undefined) ??
        (!hiddenNotUnmounted.floatingNodeExistedWhileWorkspaceBActive
          ? "Workspace A floating panel was unmounted when workspace B became active."
          : undefined) ??
        (!hiddenNotUnmounted.sameFloatingNodeWhileWorkspaceBActive
          ? "Workspace A floating panel DOM node was replaced while workspace B was active."
          : undefined) ??
        (!hiddenNotUnmounted.sameFloatingNodeAfterReturn
          ? "Workspace A floating panel DOM node was replaced after returning to workspace A."
          : undefined) ??
        (!hiddenNotUnmounted.hiddenWhileWorkspaceBActive
          ? `Workspace A floating panel remained visible while workspace B was active; hiddenMode=${hiddenNotUnmounted.hiddenMode}.`
          : undefined) ??
        (!geometryRestore.deltaIsZero
          ? `Workspace A floating panel geometry changed after restore: ${JSON.stringify(geometryRestore.deltaPx)}.`
          : undefined) ??
        (!localStorageScope.onlyWorkspaceScopedKeys
          ? `Unexpected layout keys: ${localStorageScope.observedLayoutKeys.join(",")}.`
          : undefined) ??
        (localStorageScope.entries.some((entry) => !entry.exists || !entry.hasEditorGroupsTree || entry.containsOtherWorkspaceFloatingTab)
          ? `Workspace-scoped storage failed: ${JSON.stringify(localStorageScope.entries)}.`
          : undefined) ??
        (!localStorageScope.entries[0]?.includesFloatingState
          ? `Workspace A storage key is missing floating tree/state: ${JSON.stringify(localStorageScope.entries[0])}.`
          : undefined),
    });
  } catch (error) {
    root?.unmount();
    publishResult(failedResult(stringifyErrorPart(error)));
  }
}

function FloatingWorkspaceRuntimeHarness({ services }: { services: RuntimeServices }): JSX.Element {
  const activeWorkspaceId = useStore(services.workspaces, (state) => state.activeWorkspaceId);

  return (
    <div
      data-fixture="floating-workspace-runtime"
      data-active-workspace-id={activeWorkspaceId ?? ""}
      className="h-full min-h-0 bg-background text-foreground"
      style={{ position: "relative", width: "100%", height: "100%" }}
    >
      <nav
        data-component="floating-workspace-switcher"
        className="absolute left-0 right-0 top-0 z-10 flex h-9 gap-2 border-b border-border bg-card px-3 py-1 text-xs"
      >
        {WORKSPACES.map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            data-workspace-switcher-id={workspace.id}
            data-active={workspace.id === activeWorkspaceId ? "true" : "false"}
            className="rounded border border-border px-2"
            onClick={() => services.workspaces.getState().activateWorkspace(workspace.id)}
          >
            {workspace.displayName}
          </button>
        ))}
      </nav>
      <div className="absolute bottom-0 left-0 right-0 top-9">
        {services.runtimes.map((runtime) => (
          <WorkspaceFloatingHost
            key={runtime.workspace.id}
            runtime={runtime}
            active={runtime.workspace.id === activeWorkspaceId}
          />
        ))}
      </div>
    </div>
  );
}

function WorkspaceFloatingHost({ runtime, active }: { runtime: WorkspaceRuntime; active: boolean }): JSX.Element {
  const model = useStore(runtime.editorGroups, (state) => state.model);
  const layoutSnapshot = useStore(runtime.editorGroups, (state) => state.layoutSnapshot);

  return (
    <section
      data-floating-workspace-host="true"
      data-workspace-id={runtime.workspace.id}
      data-active={active ? "true" : "false"}
      data-editor-groups-serializable={layoutSnapshot ? "true" : "false"}
      aria-hidden={active ? "false" : "true"}
      className="nexus-flexlayout absolute inset-0 bg-background"
      style={{
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
      }}
    >
      <Layout model={model} factory={(node) => renderFloatingTabContent(runtime.workspace.id, node)} supportsPopout={false} realtimeResize />
    </section>
  );
}

function renderFloatingTabContent(workspaceId: WorkspaceId, node: TabNode): JSX.Element {
  const configTab = editorGroupTabFromConfig(node.getConfig());
  const tabWorkspaceId = configTab?.workspaceId ?? workspaceId;

  return (
    <div
      data-floating-tab-content="true"
      data-workspace-id={tabWorkspaceId}
      data-tab-id={node.getId()}
      className="nexus-flexlayout__pane flex h-full min-h-0 flex-col gap-2 text-sm"
    >
      <strong>{node.getName()}</strong>
      <span>workspace: {tabWorkspaceId}</span>
    </div>
  );
}

function createRuntimeServices(): RuntimeServices {
  const workspaces = createWorkspaceService({
    openWorkspaces: WORKSPACES,
    activeWorkspaceId: WORKSPACE_A_ID,
  });
  const workspaceARuntime = createWorkspaceRuntime(WORKSPACES[0], true);
  const workspaceBRuntime = createWorkspaceRuntime(WORKSPACES[1], false);

  return {
    workspaces,
    runtimes: [workspaceARuntime, workspaceBRuntime],
  };
}

function createWorkspaceRuntime(workspace: OpenSessionWorkspace, includeFloatingPanel: boolean): WorkspaceRuntime {
  const editorGroups = createEditorGroupsService();
  const dockedTab = workspace.id === WORKSPACE_A_ID
    ? createFileTab(WORKSPACE_A_ID, WORKSPACE_A_DOCKED_TAB_ID, "workspace-a-docked.ts")
    : createFileTab(WORKSPACE_B_ID, WORKSPACE_B_DOCKED_TAB_ID, "workspace-b-docked.ts");

  editorGroups.getState().openTab(DEFAULT_EDITOR_GROUP_ID, dockedTab);

  if (includeFloatingPanel) {
    const floatingLayout = createFloatingPanelLayout(createFileTab(WORKSPACE_A_ID, FLOATING_TAB_ID, "workspace-a-floating.ts"));
    editorGroups.getState().model.doAction(Actions.createPopout(floatingLayout, FLOATING_RECT, "float"));
  }

  return {
    workspace,
    editorGroups,
  };
}

function createFloatingPanelLayout(tab: EditorGroupTab): IJsonRowNode {
  return {
    type: "row",
    children: [
      {
        type: "tabset",
        id: "group_workspace_a_floating",
        selected: 0,
        active: true,
        children: [
          {
            type: "tab",
            id: tab.id,
            name: tab.title,
            component: EDITOR_GROUP_TAB_COMPONENT,
            enablePopout: true,
            enablePopoutFloatIcon: true,
            config: {
              editorGroupTab: tab,
            },
          },
        ],
      },
    ],
  };
}

function createFileTab(workspaceId: WorkspaceId, id: string, title: string): EditorGroupTab {
  return {
    id,
    title,
    kind: "file",
    workspaceId,
    resourcePath: `src/${title}`,
  };
}

function persistAllWorkspaceLayouts(services: RuntimeServices): void {
  for (const runtime of services.runtimes) {
    services.workspaces.getState().saveLayoutModel(runtime.workspace.id, createWorkspaceRuntimeLayout(runtime));
  }
}

function createWorkspaceRuntimeLayout(runtime: WorkspaceRuntime): FloatingWorkspaceRuntimeLayout {
  return {
    schema: "floating-workspace-runtime/v1",
    workspaceId: runtime.workspace.id,
    editorGroups: runtime.editorGroups.getState().serializeModel(),
  };
}

async function waitForFloatingWindow(workspaceId: WorkspaceId, timeoutMs: number): Promise<HTMLElement> {
  await waitUntil(
    () => findFloatingWindow(workspaceId) !== null,
    timeoutMs,
    () => `Timed out waiting for floating window in ${workspaceId}.`,
  );

  const floatingWindow = findFloatingWindow(workspaceId);
  if (!floatingWindow) {
    throw new Error(`Floating window disappeared in ${workspaceId}.`);
  }

  return floatingWindow;
}

function findFloatingWindow(workspaceId: WorkspaceId): HTMLElement | null {
  const tabContent = document.querySelector<HTMLElement>(
    `[data-floating-tab-content][data-workspace-id="${escapeSelector(workspaceId)}"][data-tab-id="${FLOATING_TAB_ID}"]`,
  );

  return tabContent?.closest<HTMLElement>(".flexlayout__float_window") ?? null;
}

function readGeometry(element: HTMLElement): FloatingPanelGeometry {
  const rect = element.getBoundingClientRect();

  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function deltaGeometry(before: FloatingPanelGeometry, after: FloatingPanelGeometry): FloatingPanelGeometry {
  return {
    left: Math.abs(after.left - before.left),
    top: Math.abs(after.top - before.top),
    width: Math.abs(after.width - before.width),
    height: Math.abs(after.height - before.height),
  };
}

function isZeroDelta(delta: FloatingPanelGeometry | null): boolean {
  return delta !== null && delta.left === 0 && delta.top === 0 && delta.width === 0 && delta.height === 0;
}

function isVisuallyHidden(element: HTMLElement): boolean {
  return hiddenModeFor(element) !== "visible";
}

function hiddenModeFor(element: HTMLElement): string {
  let current: HTMLElement | null = element;

  while (current) {
    const style = window.getComputedStyle(current);
    if (style.display === "none") {
      return "display:none";
    }
    if (style.visibility === "hidden") {
      return "visibility:hidden";
    }
    if (current.hidden) {
      return "hidden-attribute";
    }
    if (current.getAttribute("aria-hidden") === "true") {
      return "aria-hidden";
    }
    current = current.parentElement;
  }

  return "visible";
}

function activeWorkspaceId(root: ParentNode): WorkspaceId | null {
  const id = root.querySelector<HTMLElement>('[data-fixture="floating-workspace-runtime"]')?.dataset.activeWorkspaceId ?? "";
  return id ? id as WorkspaceId : null;
}

function collectLocalStorageScopeEvidence(): FloatingWorkspaceRuntimeSmokeResult["localStorageScope"] {
  const expectedKeys = WORKSPACES.map((workspace) => getWorkspaceLayoutStorageKey(workspace.id));
  const observedLayoutKeys = Object.keys(localStorage)
    .filter((key) => key.startsWith("nx.layout."))
    .sort();
  const entries = WORKSPACES.map((workspace) => {
    const key = getWorkspaceLayoutStorageKey(workspace.id);
    const raw = localStorage.getItem(key);
    const parsed = raw ? safeJsonParse(raw) : null;
    const editorGroups = isRecord(parsed) && isRecord(parsed.editorGroups)
      ? parsed.editorGroups as EditorGroupsSerializedModel
      : null;
    const floatingSubLayouts = collectFloatingSubLayouts(editorGroups);
    const floatingTabIds = floatingSubLayouts.flatMap((layout) => collectTabIds(layout.layout)).sort();
    const floatingRects = floatingSubLayouts
      .map((layout) => layout.rect)
      .filter(isJsonRect)
      .map((rect) => ({
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
      }));

    return {
      workspaceId: workspace.id,
      key,
      exists: raw !== null,
      hasEditorGroupsTree: editorGroups?.layout?.type === "row",
      floatingSubLayoutCount: floatingSubLayouts.length,
      floatingTabIds,
      floatingRects,
      includesFloatingState: floatingSubLayouts.length > 0 && floatingTabIds.includes(FLOATING_TAB_ID) && floatingRects.length > 0,
      containsOtherWorkspaceFloatingTab: workspace.id !== WORKSPACE_A_ID && floatingTabIds.includes(FLOATING_TAB_ID),
    };
  });

  return {
    expectedKeys,
    observedLayoutKeys,
    onlyWorkspaceScopedKeys: observedLayoutKeys.join("|") === expectedKeys.join("|"),
    entries,
  };
}

function collectFloatingSubLayouts(editorGroups: EditorGroupsSerializedModel | null): Array<{ layout: IJsonRowNode; rect?: IJsonRect; type?: string }> {
  if (!editorGroups || !isRecord(editorGroups.subLayouts)) {
    return [];
  }

  return Object.values(editorGroups.subLayouts).filter((layout): layout is { layout: IJsonRowNode; rect?: IJsonRect; type?: string } => {
    return isRecord(layout) && layout.type === "float" && isRecord(layout.layout);
  });
}

function collectTabIds(node: unknown): string[] {
  if (!isRecord(node)) {
    return [];
  }

  const ownId = node.type === "tab" && typeof node.id === "string" ? [node.id] : [];
  const childIds = Array.isArray(node.children) ? node.children.flatMap(collectTabIds) : [];

  return ownId.concat(childIds);
}

function editorGroupTabFromConfig(config: unknown): EditorGroupTab | null {
  if (!isRecord(config) || !isRecord(config.editorGroupTab)) {
    return null;
  }

  const tab = config.editorGroupTab;
  if (typeof tab.id !== "string" || typeof tab.title !== "string") {
    return null;
  }

  return {
    id: tab.id,
    title: tab.title,
    kind: tab.kind === "diff" || tab.kind === "terminal" || tab.kind === "preview" ? tab.kind : "file",
    workspaceId: typeof tab.workspaceId === "string" ? tab.workspaceId as WorkspaceId : null,
    resourcePath: typeof tab.resourcePath === "string" ? tab.resourcePath : null,
  };
}

function isJsonRect(value: unknown): value is IJsonRect {
  return isRecord(value) &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.width === "number" &&
    typeof value.height === "number";
}

async function waitForSelector(selector: string, root: ParentNode, timeoutMs: number): Promise<HTMLElement> {
  await waitUntil(
    () => root.querySelector<HTMLElement>(selector) !== null,
    timeoutMs,
    () => `Timed out waiting for selector ${selector}`,
  );

  const element = root.querySelector<HTMLElement>(selector);
  if (!element) {
    throw new Error(`Selector disappeared after wait: ${selector}`);
  }

  return element;
}

async function waitUntil(condition: () => boolean, timeoutMs: number, describeFailure: () => string): Promise<void> {
  const startedAt = performance.now();

  while (performance.now() - startedAt < timeoutMs) {
    if (condition()) {
      return;
    }
    await settleFor(25);
  }

  throw new Error(describeFailure());
}

function settleFor(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function clearWorkspaceLayoutStorage(): void {
  const keys = Object.keys(localStorage).filter((key) => key.startsWith("nx.layout."));
  for (const key of keys) {
    localStorage.removeItem(key);
  }
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

function installConsoleCapture(): void {
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
}

function publishResult(result: FloatingWorkspaceRuntimeSmokeResult): void {
  window.__nexusFloatingWorkspaceRuntimeSmokeResult = result;
}

function failedResult(reason: string): FloatingWorkspaceRuntimeSmokeResult {
  return {
    ok: false,
    errors: [reason],
    workspaceSwitch: {
      createdInWorkspaceId: WORKSPACE_A_ID,
      switchedToWorkspaceId: WORKSPACE_B_ID,
      returnedToWorkspaceId: WORKSPACE_A_ID,
      activeWorkspaceSequence: [],
    },
    hiddenNotUnmounted: {
      floatingNodeExistedBeforeSwitch: false,
      floatingNodeExistedWhileWorkspaceBActive: false,
      sameFloatingNodeWhileWorkspaceBActive: false,
      sameFloatingNodeAfterReturn: false,
      hiddenWhileWorkspaceBActive: false,
      hiddenMode: "missing",
    },
    geometryRestore: {
      beforeSwitch: null,
      afterReturn: null,
      deltaPx: null,
      deltaIsZero: false,
    },
    localStorageScope: {
      expectedKeys: WORKSPACES.map((workspace) => getWorkspaceLayoutStorageKey(workspace.id)),
      observedLayoutKeys: [],
      onlyWorkspaceScopedKeys: false,
      entries: [],
    },
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

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeSelector(value: string): string {
  return CSS.escape(value);
}
