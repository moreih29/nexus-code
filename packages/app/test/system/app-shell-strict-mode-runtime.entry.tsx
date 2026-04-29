import { StrictMode, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { WorkspaceFileTreeNode } from "../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import type { OpenSessionWorkspace, WorkspaceSidebarState } from "../../../shared/src/contracts/workspace/workspace-shell";
import { installMonacoEnvironment } from "../../src/renderer/editor/monaco-environment";
import "../../src/renderer/styles.css";
import "../../src/renderer/parts/editor-groups/flexlayout-theme.css";
import "@xterm/xterm/css/xterm.css";

type Disposable = { dispose(): void };
type GenericListener = (event: unknown) => void;
type EditorListener = (event: unknown) => void;

type AppServicesLike = Record<string, unknown> & {
  terminal?: TerminalServiceStoreLike;
};

type TerminalServiceStoreLike = {
  getState(): {
    getLifecycleSnapshot?: () => { shellMounted?: unknown };
  };
};

interface BridgeListenerCounts {
  claudeConsent: number;
  editor: number;
  harness: number;
  search: number;
  sourceControl: number;
  terminal: number;
  workspace: number;
}

interface WarningCapture {
  getSnapshotShouldBeCached: number;
  maximumUpdateDepthExceeded: number;
  messages: string[];
}

interface AppShellZoneMounts {
  activityBar: boolean;
  sideBar: boolean;
  editorGroups: boolean;
  bottomPanel: boolean;
  terminalPane: boolean;
}

interface StrictModeCycleResult {
  cycle: number;
  zoneMounts: AppShellZoneMounts;
  listenerCountsWhileMounted: BridgeListenerCounts;
  activeLifecycleCountWhileMounted: number;
  terminalShellMountedWhileMountedCount: number;
  rootDomNodeCountWhileMounted: number;
  listenerCountsAfterUnmount: BridgeListenerCounts;
  listenerLeakCount: number;
  activeLifecycleCountAfterUnmount: number;
  terminalShellMountedAfterUnmountCount: number;
  rootDomNodeCountAfterUnmount: number;
  extraBodyNodeCountAfterUnmount: number;
  domLeakCount: number;
  warningsAfterUnmount: WarningCapture;
}

interface ServiceCreationRecord {
  id: number;
  cycle: number;
  serviceKeys: string[];
  expectedServiceKeys: string[];
  missingServiceKeys: string[];
  coreServiceInstanceIds: Record<string, number | null>;
  terminalLifecycleExposed: boolean;
}

interface ServiceLifecycleSummary {
  expectedServiceKeys: string[];
  expectedServiceCount: number;
  createdServiceSetCount: number;
  creationRecords: ServiceCreationRecord[];
  missingServiceKeys: string[];
  lifecycleMountCount: number;
  lifecycleUnmountCount: number;
  mountUnmountBalanced: boolean;
  finalActiveLifecycleCount: number;
  finalBridgeListenerCounts: BridgeListenerCounts;
  finalBridgeListenerLeakCount: number;
  finalTerminalShellMountedCount: number;
  terminalLifecycleExposed: boolean;
  perCycle: StrictModeCycleResult[];
}

interface AppShellStrictModeRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  strictMode: {
    iterations: number;
    stableIterations: number;
  };
  warningCapture: WarningCapture;
  zoneMounts: AppShellZoneMounts[];
  serviceLifecycle: ServiceLifecycleSummary;
  domLeak: {
    totalLeakCount: number;
    perCycle: Array<{
      cycle: number;
      rootDomNodeCountAfterUnmount: number;
      extraBodyNodeCountAfterUnmount: number;
      domLeakCount: number;
    }>;
  };
  reason?: string;
}

interface StrictModeLifecycleProbe {
  onServicesCreated(services: AppServicesLike): void;
  onLifecycleMounted(services: Pick<AppServicesLike, "terminal">): void;
  onLifecycleUnmounted(services: Pick<AppServicesLike, "terminal">): void;
}

declare global {
  interface Window {
    __nexusAppShellStrictModeRuntimeSmokeResult?: AppShellStrictModeRuntimeSmokeResult;
    __nexusAppShellStrictModeLifecycleProbe?: StrictModeLifecycleProbe;
  }
}

const STRICT_MODE_ITERATIONS = 5;
const EXPECTED_CORE_SERVICE_KEYS = [
  "activityBar",
  "bottomPanel",
  "editorDocuments",
  "editorGroups",
  "editorWorkspace",
  "files",
  "git",
  "lsp",
  "search",
  "sourceControl",
  "terminal",
];
const workspaceId = "ws_app_shell_strict_mode_runtime" as WorkspaceId;
const workspaceRoot = "/tmp/nexus-app-shell-strict-mode-runtime";
const activeWorkspace: OpenSessionWorkspace = {
  id: workspaceId,
  displayName: "StrictMode Runtime",
  absolutePath: workspaceRoot,
};
const sidebarState: WorkspaceSidebarState = {
  openWorkspaces: [activeWorkspace],
  activeWorkspaceId: workspaceId,
};
const fixtureNodes: WorkspaceFileTreeNode[] = [
  {
    name: "src",
    path: "src",
    kind: "directory",
    children: [
      { name: "alpha.ts", path: "src/alpha.ts", kind: "file" },
      { name: "beta.ts", path: "src/beta.ts", kind: "file" },
    ],
  },
  { name: "README.md", path: "README.md", kind: "file" },
];
const workspaceListeners = new Set<(state: WorkspaceSidebarState) => void>();
const editorListeners = new Set<EditorListener>();
const harnessListeners = new Set<GenericListener>();
const searchListeners = new Set<GenericListener>();
const sourceControlListeners = new Set<GenericListener>();
const terminalListeners = new Set<GenericListener>();
const claudeConsentListeners = new Set<GenericListener>();
const capturedConsoleMessages: string[] = [];
const capturedErrors: string[] = [];
const updateDepthWarningPattern = /getSnapshot should be cached|Maximum update depth exceeded/i;
const suspiciousMessagePattern =
  /Maximum update depth exceeded|Cannot update a component|error boundary|uncaught|unhandled|getSnapshot should be cached|not wrapped in act|Could not create web worker|MonacoEnvironment\.getWorker|MonacoEnvironment\.getWorkerUrl|worker_file|ts\.worker|json\.worker|Falling back to loading web worker code in main thread|Uncaught \[object Event\]|Uncaught Event/i;
const counters = {
  treeReadCount: 0,
  terminalOpenCount: 0,
  terminalInputCount: 0,
  terminalResizeCount: 0,
  terminalCloseCount: 0,
};
const lifecycleProbeState = createLifecycleProbeState();

installMonacoEnvironment();
installConsoleCapture();
installPreloadMocks();
window.__nexusAppShellStrictModeLifecycleProbe = lifecycleProbeState.probe;
void runSmoke();

async function runSmoke(): Promise<void> {
  try {
    const rootElement = document.getElementById("app");
    if (!rootElement) {
      publishResult(failedResult("Missing #app root"));
      return;
    }

    prepareDocument(rootElement);
    const { default: App } = await import("../../src/renderer/App");
    const perCycle: StrictModeCycleResult[] = [];

    for (let cycle = 1; cycle <= STRICT_MODE_ITERATIONS; cycle += 1) {
      lifecycleProbeState.setCurrentCycle(cycle);
      const root = createRoot(rootElement);
      root.render(createElement(StrictMode, null, createElement(App)));

      await waitForStableAppShellMount(rootElement, cycle);
      await settleFor(120);

      const zoneMounts = collectZoneMounts();
      const listenerCountsWhileMounted = bridgeListenerCounts();
      const activeLifecycleCountWhileMounted = lifecycleProbeState.activeLifecycleCount();
      const terminalShellMountedWhileMountedCount = lifecycleProbeState.terminalShellMountedCount();
      const rootDomNodeCountWhileMounted = rootElement.childNodes.length;

      root.unmount();
      await settleAfterUnmount();

      const listenerCountsAfterUnmount = bridgeListenerCounts();
      const rootDomNodeCountAfterUnmount = rootElement.childNodes.length;
      const extraBodyNodeCountAfterUnmount = countExtraBodyNodesAfterUnmount(rootElement);
      const listenerLeakCount = totalBridgeListenerCount(listenerCountsAfterUnmount);
      const activeLifecycleCountAfterUnmount = lifecycleProbeState.activeLifecycleCount();
      const terminalShellMountedAfterUnmountCount = lifecycleProbeState.terminalShellMountedCount();
      const domLeakCount = rootDomNodeCountAfterUnmount + extraBodyNodeCountAfterUnmount;

      perCycle.push({
        cycle,
        zoneMounts,
        listenerCountsWhileMounted,
        activeLifecycleCountWhileMounted,
        terminalShellMountedWhileMountedCount,
        rootDomNodeCountWhileMounted,
        listenerCountsAfterUnmount,
        listenerLeakCount,
        activeLifecycleCountAfterUnmount,
        terminalShellMountedAfterUnmountCount,
        rootDomNodeCountAfterUnmount,
        extraBodyNodeCountAfterUnmount,
        domLeakCount,
        warningsAfterUnmount: collectUpdateDepthWarnings(),
      });
    }

    const warningCapture = collectUpdateDepthWarnings();
    const fatalErrors = capturedErrors.filter((message) => suspiciousMessagePattern.test(message));
    const serviceLifecycle = lifecycleProbeState.summary(perCycle);
    const domLeak = {
      totalLeakCount: perCycle.reduce((sum, cycle) => sum + cycle.domLeakCount, 0),
      perCycle: perCycle.map((cycle) => ({
        cycle: cycle.cycle,
        rootDomNodeCountAfterUnmount: cycle.rootDomNodeCountAfterUnmount,
        extraBodyNodeCountAfterUnmount: cycle.extraBodyNodeCountAfterUnmount,
        domLeakCount: cycle.domLeakCount,
      })),
    };
    const stableIterations = perCycle.filter((cycle) => {
      return Object.values(cycle.zoneMounts).every(Boolean) &&
        cycle.listenerLeakCount === 0 &&
        cycle.activeLifecycleCountAfterUnmount === 0 &&
        cycle.terminalShellMountedAfterUnmountCount === 0 &&
        cycle.domLeakCount === 0;
    }).length;
    const missingServiceKeys = serviceLifecycle.missingServiceKeys;
    const ok =
      fatalErrors.length === 0 &&
      warningCapture.getSnapshotShouldBeCached === 0 &&
      warningCapture.maximumUpdateDepthExceeded === 0 &&
      stableIterations === STRICT_MODE_ITERATIONS &&
      serviceLifecycle.expectedServiceCount === 11 &&
      missingServiceKeys.length === 0 &&
      serviceLifecycle.lifecycleMountCount >= STRICT_MODE_ITERATIONS &&
      serviceLifecycle.mountUnmountBalanced &&
      serviceLifecycle.finalActiveLifecycleCount === 0 &&
      serviceLifecycle.finalBridgeListenerLeakCount === 0 &&
      serviceLifecycle.finalTerminalShellMountedCount === 0 &&
      serviceLifecycle.terminalLifecycleExposed &&
      domLeak.totalLeakCount === 0;

    publishResult({
      ok,
      errors: [
        ...fatalErrors,
        ...missingServiceKeys.map((key) => `Missing expected app service: ${key}`),
        ...(stableIterations === STRICT_MODE_ITERATIONS ? [] : [
          `Only ${stableIterations}/${STRICT_MODE_ITERATIONS} StrictMode mount/unmount iterations were stable.`,
        ]),
      ],
      strictMode: {
        iterations: STRICT_MODE_ITERATIONS,
        stableIterations,
      },
      warningCapture,
      zoneMounts: perCycle.map((cycle) => cycle.zoneMounts),
      serviceLifecycle,
      domLeak,
      reason:
        fatalErrors[0] ??
        warningCapture.messages[0] ??
        (missingServiceKeys.length > 0 ? `Missing expected app service keys: ${missingServiceKeys.join(", ")}` : undefined) ??
        (stableIterations !== STRICT_MODE_ITERATIONS
          ? `StrictMode runtime cycles unstable: ${stableIterations}/${STRICT_MODE_ITERATIONS}`
          : undefined) ??
        (serviceLifecycle.finalBridgeListenerLeakCount > 0
          ? `Bridge listener leak count after final unmount: ${serviceLifecycle.finalBridgeListenerLeakCount}`
          : undefined) ??
        (serviceLifecycle.finalTerminalShellMountedCount > 0
          ? `Terminal shell lifecycle still mounted after unmount: ${serviceLifecycle.finalTerminalShellMountedCount}`
          : undefined) ??
        (domLeak.totalLeakCount > 0 ? `DOM leak count after cycles: ${domLeak.totalLeakCount}` : undefined),
    });
  } catch (error) {
    publishResult(failedResult(stringifyErrorPart(error)));
  } finally {
    window.__nexusAppShellStrictModeLifecycleProbe = undefined;
  }
}

function createLifecycleProbeState(): {
  probe: StrictModeLifecycleProbe;
  setCurrentCycle(cycle: number): void;
  activeLifecycleCount(): number;
  terminalShellMountedCount(): number;
  summary(perCycle: StrictModeCycleResult[]): ServiceLifecycleSummary;
} {
  const serviceSetIds = new WeakMap<object, number>();
  const serviceInstanceIds = new WeakMap<object, number>();
  const terminalStoresByServiceSetId = new Map<number, TerminalServiceStoreLike>();
  const activeLifecycleServiceSetIds = new Set<number>();
  const creationRecords: ServiceCreationRecord[] = [];
  const lifecycleEvents: Array<{ serviceSetId: number; type: "mount" | "unmount"; cycle: number }> = [];
  let nextServiceSetId = 1;
  let nextServiceInstanceId = 1;
  let currentCycle = 0;

  function serviceSetIdFor(services: unknown): number {
    if (!isObject(services)) {
      return -1;
    }

    const existing = serviceSetIds.get(services);
    if (existing) {
      return existing;
    }

    const next = nextServiceSetId++;
    serviceSetIds.set(services, next);
    return next;
  }

  function serviceInstanceIdFor(value: unknown): number | null {
    if (!isStoreLike(value)) {
      return null;
    }

    const existing = serviceInstanceIds.get(value);
    if (existing) {
      return existing;
    }

    const next = nextServiceInstanceId++;
    serviceInstanceIds.set(value, next);
    return next;
  }

  function terminalShellMountedCount(): number {
    let mountedCount = 0;
    for (const terminalStore of terminalStoresByServiceSetId.values()) {
      if (terminalShellMounted(terminalStore) === true) {
        mountedCount += 1;
      }
    }
    return mountedCount;
  }

  return {
    probe: {
      onServicesCreated(services) {
        const id = serviceSetIdFor(services);
        const serviceKeys = Object.keys(services).sort();
        const coreServiceInstanceIds = Object.fromEntries(
          EXPECTED_CORE_SERVICE_KEYS.map((key) => [key, serviceInstanceIdFor(services[key])]),
        ) as Record<string, number | null>;
        const missingServiceKeys = EXPECTED_CORE_SERVICE_KEYS.filter((key) => coreServiceInstanceIds[key] === null);
        const terminalLifecycleExposed = terminalShellMounted(services.terminal) !== null;

        if (isTerminalStoreLike(services.terminal)) {
          terminalStoresByServiceSetId.set(id, services.terminal);
        }

        creationRecords.push({
          id,
          cycle: currentCycle,
          serviceKeys,
          expectedServiceKeys: [...EXPECTED_CORE_SERVICE_KEYS],
          missingServiceKeys,
          coreServiceInstanceIds,
          terminalLifecycleExposed,
        });
      },
      onLifecycleMounted(services) {
        const id = serviceSetIdFor(services);
        activeLifecycleServiceSetIds.add(id);
        if (isTerminalStoreLike(services.terminal)) {
          terminalStoresByServiceSetId.set(id, services.terminal);
        }
        lifecycleEvents.push({ serviceSetId: id, type: "mount", cycle: currentCycle });
      },
      onLifecycleUnmounted(services) {
        const id = serviceSetIdFor(services);
        activeLifecycleServiceSetIds.delete(id);
        lifecycleEvents.push({ serviceSetId: id, type: "unmount", cycle: currentCycle });
      },
    },
    setCurrentCycle(cycle) {
      currentCycle = cycle;
    },
    activeLifecycleCount() {
      return activeLifecycleServiceSetIds.size;
    },
    terminalShellMountedCount,
    summary(perCycle) {
      const finalBridgeListenerCounts = bridgeListenerCounts();
      const missingServiceKeys = Array.from(new Set(creationRecords.flatMap((record) => record.missingServiceKeys))).sort();
      const lifecycleMountCount = lifecycleEvents.filter((event) => event.type === "mount").length;
      const lifecycleUnmountCount = lifecycleEvents.filter((event) => event.type === "unmount").length;
      return {
        expectedServiceKeys: [...EXPECTED_CORE_SERVICE_KEYS],
        expectedServiceCount: EXPECTED_CORE_SERVICE_KEYS.length,
        createdServiceSetCount: creationRecords.length,
        creationRecords,
        missingServiceKeys,
        lifecycleMountCount,
        lifecycleUnmountCount,
        mountUnmountBalanced: lifecycleMountCount === lifecycleUnmountCount,
        finalActiveLifecycleCount: activeLifecycleServiceSetIds.size,
        finalBridgeListenerCounts,
        finalBridgeListenerLeakCount: totalBridgeListenerCount(finalBridgeListenerCounts),
        finalTerminalShellMountedCount: terminalShellMountedCount(),
        terminalLifecycleExposed: creationRecords.some((record) => record.terminalLifecycleExposed),
        perCycle,
      };
    },
  };
}

async function waitForStableAppShellMount(rootElement: HTMLElement, cycle: number): Promise<void> {
  await waitForSelector('[data-component="activity-bar"]', rootElement, 10_000, cycle);
  await waitForSelector('[data-component="side-bar"][data-active-content-id="explorer"]', rootElement, 10_000, cycle);
  await waitForSelector('[data-component="editor-groups-part"]', rootElement, 10_000, cycle);
  await waitForSelector('[data-component="bottom-panel"]', rootElement, 10_000, cycle);
  await waitForSelector('[data-component="terminal-pane"]', rootElement, 10_000, cycle);
}

function collectZoneMounts(): AppShellZoneMounts {
  return {
    activityBar: document.querySelector('[data-component="activity-bar"]') !== null,
    sideBar: document.querySelector('[data-component="side-bar"]') !== null,
    editorGroups: document.querySelector('[data-component="editor-groups-part"]') !== null,
    bottomPanel: document.querySelector('[data-component="bottom-panel"]') !== null,
    terminalPane: document.querySelector('[data-component="terminal-pane"]') !== null,
  };
}

function installPreloadMocks(): void {
  Object.assign(window, {
    nexusWorkspace: {
      async openFolder() {
        return cloneSidebarState();
      },
      async activateWorkspace() {
        return cloneSidebarState();
      },
      async closeWorkspace() {
        return cloneSidebarState();
      },
      async restoreSession() {
        return cloneSidebarState();
      },
      async getSidebarState() {
        return cloneSidebarState();
      },
      onSidebarStateChanged(listener: (nextState: WorkspaceSidebarState) => void): Disposable {
        workspaceListeners.add(listener);
        return disposable(() => workspaceListeners.delete(listener));
      },
    },
    nexusHarness: {
      onObserverEvent(listener: GenericListener): Disposable {
        harnessListeners.add(listener);
        return disposable(() => harnessListeners.delete(listener));
      },
    },
    nexusClaudeSettings: {
      onConsentRequest(listener: GenericListener): Disposable {
        claudeConsentListeners.add(listener);
        return disposable(() => claudeConsentListeners.delete(listener));
      },
      async respondConsentRequest() {},
    },
    nexusWorkspaceDiff: {
      async readWorkspaceDiff() {
        return {
          type: "workspace/diff/read/result",
          workspaceId,
          files: [],
          generatedAt: new Date(0).toISOString(),
        };
      },
    },
    nexusClaudeSession: {
      async readTranscript() {
        return {
          type: "claude/session/transcript/read/result",
          entries: [],
          readAt: new Date(0).toISOString(),
        };
      },
    },
    nexusEditor: {
      async invoke(request: { type: string; [key: string]: unknown }) {
        return handleEditorInvoke(request);
      },
      onEvent(listener: EditorListener): Disposable {
        editorListeners.add(listener);
        return disposable(() => editorListeners.delete(listener));
      },
    },
    nexusSearch: {
      async startSearch(command: { requestId?: string; workspaceId?: WorkspaceId }) {
        return {
          type: "search/lifecycle",
          action: "failed",
          requestId: command.requestId ?? "app-shell-strict-mode-search-request",
          workspaceId: command.workspaceId ?? workspaceId,
          message: "Search is disabled in app shell strict mode smoke.",
          failedAt: new Date(0).toISOString(),
        };
      },
      async cancelSearch() {},
      onEvent(listener: GenericListener): Disposable {
        searchListeners.add(listener);
        return disposable(() => searchListeners.delete(listener));
      },
    },
    nexusGit: {
      async invoke(request: { action?: string; requestId?: string; workspaceId?: WorkspaceId }) {
        return {
          type: "git/lifecycle",
          action: "failed",
          requestId: request.requestId ?? `app-shell-strict-mode-${request.action ?? "request"}`,
          workspaceId: request.workspaceId ?? workspaceId,
          message: "Git is disabled in app shell strict mode smoke.",
          failedAt: new Date(0).toISOString(),
        };
      },
      onEvent(listener: GenericListener): Disposable {
        sourceControlListeners.add(listener);
        return disposable(() => sourceControlListeners.delete(listener));
      },
    },
    nexusFileActions: {
      async invoke(request: { type: string; [key: string]: unknown }) {
        return {
          type: `${request.type}/result`,
          workspaceId: request.workspaceId ?? workspaceId,
          path: request.path ?? null,
          ok: true,
        };
      },
      async startFileDrag() {
        return { type: "file-actions/drag/start/result", started: true };
      },
      getPathForFile(file: File) {
        return `/tmp/${file.name}`;
      },
    },
    nexusTerminal: {
      async invoke(command: { type: string; workspaceId?: WorkspaceId; tabId?: string }) {
        switch (command.type) {
          case "terminal/open":
            counters.terminalOpenCount += 1;
            return {
              type: "terminal/opened",
              tabId: `tt_${command.workspaceId ?? workspaceId}_${counters.terminalOpenCount}`,
              workspaceId: command.workspaceId ?? workspaceId,
              pid: 20_000 + counters.terminalOpenCount,
            };
          case "terminal/input":
            counters.terminalInputCount += 1;
            return undefined;
          case "terminal/resize":
            counters.terminalResizeCount += 1;
            return undefined;
          case "terminal/close":
            counters.terminalCloseCount += 1;
            return {
              type: "terminal/exited",
              tabId: command.tabId,
              workspaceId,
              reason: "user-close",
              exitCode: 0,
            };
          case "terminal/scrollback-stats/query":
            return {
              type: "terminal/scrollback-stats/reply",
              tabId: command.tabId,
              mainBufferByteLimit: 0,
              mainBufferStoredBytes: 0,
              mainBufferDroppedBytesTotal: 0,
              xtermScrollbackLines: 0,
            };
          default:
            return undefined;
        }
      },
      onEvent(listener: GenericListener): Disposable {
        terminalListeners.add(listener);
        return disposable(() => terminalListeners.delete(listener));
      },
    },
  });
}

function handleEditorInvoke(request: { type: string; [key: string]: unknown }): unknown {
  switch (request.type) {
    case "workspace-files/tree/read":
      counters.treeReadCount += 1;
      return {
        type: "workspace-files/tree/read/result",
        workspaceId: request.workspaceId ?? workspaceId,
        rootPath: workspaceRoot,
        nodes: cloneFixtureNodes(),
        readAt: new Date(counters.treeReadCount).toISOString(),
      };
    case "workspace-files/file/read":
      return {
        type: "workspace-files/file/read/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        content: fixtureFileContent(String(request.path ?? "unknown.ts")),
        encoding: "utf8",
        version: "v1",
        readAt: new Date(0).toISOString(),
      };
    case "workspace-files/file/write":
      return {
        type: "workspace-files/file/write/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        encoding: "utf8",
        version: "v2",
        writtenAt: new Date(0).toISOString(),
      };
    case "workspace-files/file/create":
      return {
        type: "workspace-files/file/create/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        kind: request.kind,
        createdAt: new Date(0).toISOString(),
      };
    case "workspace-files/file/delete":
      return {
        type: "workspace-files/file/delete/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        deletedAt: new Date(0).toISOString(),
      };
    case "workspace-files/file/rename":
      return {
        type: "workspace-files/file/rename/result",
        workspaceId: request.workspaceId ?? workspaceId,
        oldPath: request.oldPath,
        newPath: request.newPath,
        renamedAt: new Date(0).toISOString(),
      };
    case "workspace-git-badges/read":
      return {
        type: "workspace-git-badges/read/result",
        workspaceId: request.workspaceId ?? workspaceId,
        badges: [],
        readAt: new Date(0).toISOString(),
      };
    case "lsp-document/open":
      return {
        type: "lsp-document/open/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        status: lspReadyStatus(request.language),
        openedAt: new Date(0).toISOString(),
      };
    case "lsp-document/change":
      return {
        type: "lsp-document/change/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        status: lspReadyStatus(request.language),
        changedAt: new Date(0).toISOString(),
      };
    case "lsp-document/close":
      return {
        type: "lsp-document/close/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        closedAt: new Date(0).toISOString(),
      };
    case "lsp-diagnostics/read":
      return {
        type: "lsp-diagnostics/read/result",
        workspaceId: request.workspaceId ?? workspaceId,
        diagnostics: [],
        readAt: new Date(0).toISOString(),
      };
    case "lsp-status/read":
      return {
        type: "lsp-status/read/result",
        workspaceId: request.workspaceId ?? workspaceId,
        statuses: ["typescript", "python", "go"].map((language) => lspReadyStatus(language)),
        readAt: new Date(0).toISOString(),
      };
    case "lsp-completion/complete":
      return {
        type: "lsp-completion/complete/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        isIncomplete: false,
        items: [],
        completedAt: new Date(0).toISOString(),
      };
    case "lsp-hover/read":
      return {
        type: "lsp-hover/read/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        contents: [],
        range: null,
        readAt: new Date(0).toISOString(),
      };
    case "lsp-definition/read":
      return {
        type: "lsp-definition/read/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        targets: [],
        readAt: new Date(0).toISOString(),
      };
    case "lsp-references/read":
      return {
        type: "lsp-references/read/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        locations: [],
        readAt: new Date(0).toISOString(),
      };
    case "lsp-document-symbols/read":
      return {
        type: "lsp-document-symbols/read/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        symbols: [],
        readAt: new Date(0).toISOString(),
      };
    case "lsp-rename/prepare":
      return {
        type: "lsp-rename/prepare/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        canRename: false,
        range: null,
        placeholder: null,
        defaultBehavior: false,
        preparedAt: new Date(0).toISOString(),
      };
    case "lsp-rename/rename":
      return {
        type: "lsp-rename/rename/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        workspaceEdit: { changes: [] },
        renamedAt: new Date(0).toISOString(),
      };
    case "lsp-formatting/document":
      return {
        type: "lsp-formatting/document/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        edits: [],
        formattedAt: new Date(0).toISOString(),
      };
    case "lsp-formatting/range":
      return {
        type: "lsp-formatting/range/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        edits: [],
        formattedAt: new Date(0).toISOString(),
      };
    case "lsp-signature-help/get":
      return {
        type: "lsp-signature-help/get/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        signatureHelp: null,
        resolvedAt: new Date(0).toISOString(),
      };
    case "lsp-code-action/list":
      return {
        type: "lsp-code-action/list/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        actions: [],
        listedAt: new Date(0).toISOString(),
      };
    default:
      throw new Error(`Unexpected editor bridge request in app shell strict mode smoke: ${request.type}`);
  }
}

function bridgeListenerCounts(): BridgeListenerCounts {
  return {
    claudeConsent: claudeConsentListeners.size,
    editor: editorListeners.size,
    harness: harnessListeners.size,
    search: searchListeners.size,
    sourceControl: sourceControlListeners.size,
    terminal: terminalListeners.size,
    workspace: workspaceListeners.size,
  };
}

function totalBridgeListenerCount(counts: BridgeListenerCounts): number {
  return counts.claudeConsent +
    counts.editor +
    counts.harness +
    counts.search +
    counts.sourceControl +
    counts.terminal +
    counts.workspace;
}

function countExtraBodyNodesAfterUnmount(rootElement: HTMLElement): number {
  return Array.from(document.body.children).filter((element) => {
    if (element === rootElement) {
      return false;
    }
    if (element.tagName.toLowerCase() === "script") {
      return false;
    }
    return true;
  }).length;
}

function collectUpdateDepthWarnings(): WarningCapture {
  const messages = capturedConsoleMessages.filter((message) => updateDepthWarningPattern.test(message));
  return {
    getSnapshotShouldBeCached: messages.filter((message) => /getSnapshot should be cached/i.test(message)).length,
    maximumUpdateDepthExceeded: messages.filter((message) => /Maximum update depth exceeded/i.test(message)).length,
    messages,
  };
}

function terminalShellMounted(value: unknown): boolean | null {
  if (!isTerminalStoreLike(value)) {
    return null;
  }

  const snapshot = value.getState().getLifecycleSnapshot?.();
  return typeof snapshot?.shellMounted === "boolean" ? snapshot.shellMounted : null;
}

function isTerminalStoreLike(value: unknown): value is TerminalServiceStoreLike {
  if (!isStoreLike(value)) {
    return false;
  }

  const state = value.getState();
  return isObject(state) && typeof state.getLifecycleSnapshot === "function";
}

function isStoreLike(value: unknown): value is { getState(): unknown } {
  return isObject(value) && typeof value.getState === "function";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

function fixtureFileContent(path: string): string {
  const symbol = path.replace(/\W+/g, "_").replace(/^_+|_+$/g, "") || "fixture";
  return `export const ${symbol} = true;\n`;
}

function lspReadyStatus(language: unknown): {
  language: "typescript" | "python" | "go";
  state: "ready";
  serverName: string;
  message: null;
  updatedAt: string;
} {
  const normalizedLanguage = language === "python" || language === "go" ? language : "typescript";
  return {
    language: normalizedLanguage,
    state: "ready",
    serverName: `${normalizedLanguage}-app-shell-strict-mode-smoke`,
    message: null,
    updatedAt: new Date(0).toISOString(),
  };
}

function cloneSidebarState(): WorkspaceSidebarState {
  return {
    openWorkspaces: sidebarState.openWorkspaces.map((workspace) => ({ ...workspace })),
    activeWorkspaceId: sidebarState.activeWorkspaceId,
  };
}

function cloneFixtureNodes(): WorkspaceFileTreeNode[] {
  return fixtureNodes.map(cloneFixtureNode);
}

function cloneFixtureNode(node: WorkspaceFileTreeNode): WorkspaceFileTreeNode {
  if (node.kind === "directory") {
    return {
      ...node,
      children: node.children?.map(cloneFixtureNode) ?? [],
    };
  }
  return { ...node };
}

function installConsoleCapture(): void {
  const originalConsoleError = console.error.bind(console);
  const originalConsoleWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    const message = args.map(stringifyErrorPart).join(" ");
    capturedConsoleMessages.push(message);
    capturedErrors.push(message);
    originalConsoleError(...args);
  };
  console.warn = (...args: unknown[]) => {
    const message = args.map(stringifyErrorPart).join(" ");
    capturedConsoleMessages.push(message);
    if (suspiciousMessagePattern.test(message)) {
      capturedErrors.push(message);
    }
    originalConsoleWarn(...args);
  };
  window.addEventListener("error", (event) => {
    const message = stringifyErrorPart(event.error ?? event.message ?? event);
    capturedConsoleMessages.push(message);
    capturedErrors.push(message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const message = stringifyErrorPart(event.reason);
    capturedConsoleMessages.push(message);
    capturedErrors.push(message);
  });
}

function prepareDocument(rootElement: HTMLElement): void {
  document.documentElement.style.width = "1280px";
  document.documentElement.style.height = "900px";
  document.body.style.width = "1280px";
  document.body.style.height = "900px";
  document.body.style.margin = "0";
  rootElement.style.width = "1280px";
  rootElement.style.height = "900px";
}

function disposable(dispose: () => void): Disposable {
  let disposed = false;
  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      dispose();
    },
  };
}

async function waitForSelector(
  selector: string,
  rootElement: HTMLElement,
  timeoutMs: number,
  cycle: number,
): Promise<HTMLElement> {
  let latest: HTMLElement | null = null;
  await waitUntil(() => {
    latest = rootElement.querySelector<HTMLElement>(selector);
    return latest !== null;
  }, timeoutMs, () => `Timed out waiting for selector ${selector} in StrictMode cycle ${cycle}`);
  return latest!;
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

function settleFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function settleAfterUnmount(): Promise<void> {
  await animationFrame();
  await animationFrame();
  await settleFor(50);
}

function failedResult(reason: string): AppShellStrictModeRuntimeSmokeResult {
  const emptyCounts: BridgeListenerCounts = {
    claudeConsent: 0,
    editor: 0,
    harness: 0,
    search: 0,
    sourceControl: 0,
    terminal: 0,
    workspace: 0,
  };
  return {
    ok: false,
    errors: [reason],
    strictMode: {
      iterations: STRICT_MODE_ITERATIONS,
      stableIterations: 0,
    },
    warningCapture: collectUpdateDepthWarnings(),
    zoneMounts: [],
    serviceLifecycle: {
      expectedServiceKeys: [...EXPECTED_CORE_SERVICE_KEYS],
      expectedServiceCount: EXPECTED_CORE_SERVICE_KEYS.length,
      createdServiceSetCount: 0,
      creationRecords: [],
      missingServiceKeys: [],
      lifecycleMountCount: 0,
      lifecycleUnmountCount: 0,
      mountUnmountBalanced: false,
      finalActiveLifecycleCount: 0,
      finalBridgeListenerCounts: emptyCounts,
      finalBridgeListenerLeakCount: 0,
      finalTerminalShellMountedCount: 0,
      terminalLifecycleExposed: false,
      perCycle: [],
    },
    domLeak: {
      totalLeakCount: 0,
      perCycle: [],
    },
    reason,
  };
}

function stringifyErrorPart(part: unknown): string {
  if (part instanceof Error) {
    return `${part.message}\n${part.stack ?? ""}`;
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

function publishResult(result: AppShellStrictModeRuntimeSmokeResult): void {
  window.__nexusAppShellStrictModeRuntimeSmokeResult = result;
}
