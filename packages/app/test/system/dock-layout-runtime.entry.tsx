import { StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";

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

interface DockLayoutRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  productionPath: {
    appShellMounted: boolean;
    editorGroupsPartMounted: boolean;
    editorGridProvider: string | null;
    flexlayoutProviderMatched: boolean;
    legacySplitPaneBridgeMatched: boolean;
    splitEditorPaneBridgeMounted: boolean;
  };
  fourPaneScenario: {
    fixtureFiles: string[];
    openedTabTitles: string[];
    openedTabCount: number;
    splitCommandCount: number;
    moveCommandCount: number;
    finalGridPaneCount: number;
    finalGridTabCount: number;
    gridSlots: Array<{
      index: number;
      groupId: string;
      tabCount: number;
      activeTabId: string;
    }>;
    legacyVisualPaneIds: string[];
    operationLog: string[];
  };
  packageImpact: {
    flexlayoutVersion: string;
    dependencyPinned: boolean;
  };
  reason?: string;
}

declare global {
  interface Window {
    __nexusDockLayoutRuntimeSmokeResult?: DockLayoutRuntimeSmokeResult;
  }
}

const workspaceId = "ws_dock_layout_runtime" as WorkspaceId;
const workspaceRoot = "/tmp/nexus-dock-layout-runtime";
const activeWorkspace: OpenSessionWorkspace = {
  id: workspaceId,
  displayName: "Dock Runtime",
  absolutePath: workspaceRoot,
};
const sidebarState: WorkspaceSidebarState = {
  openWorkspaces: [activeWorkspace],
  activeWorkspaceId: workspaceId,
};
const legacySplitPaneBridgeProvider = ["legacy", "split", "pane", "bridge"].join("-");
const fixtureFiles = ["alpha.ts", "beta.ts", "gamma.ts", "delta.ts"];
const fixtureNodes: WorkspaceFileTreeNode[] = fixtureFiles.map((path) => ({
  name: path,
  path,
  kind: "file",
}));
const capturedConsoleMessages: string[] = [];
const capturedErrors: string[] = [];
const workspaceListeners = new Set<(state: WorkspaceSidebarState) => void>();
const editorListeners = new Set<EditorListener>();
const harnessListeners = new Set<GenericListener>();
const searchListeners = new Set<GenericListener>();
const gitListeners = new Set<GenericListener>();
const terminalListeners = new Set<GenericListener>();
const claudeConsentListeners = new Set<GenericListener>();
const counters = {
  treeReadCount: 0,
  terminalOpenCount: 0,
  gitInvokeActions: [] as string[],
};
const suspiciousMessagePattern =
  /Maximum update depth exceeded|Cannot update a component|error boundary|uncaught|unhandled|getSnapshot should be cached|not wrapped in act|Could not create web worker|MonacoEnvironment\.getWorker|MonacoEnvironment\.getWorkerUrl|worker_file|ts\.worker|json\.worker|Falling back to loading web worker code in main thread|Uncaught \[object Event\]|Uncaught Event/i;

installMonacoEnvironment();
installConsoleCapture();
installPreloadMocks();
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
    createRoot(rootElement).render(createElement(StrictMode, null, createElement(App)));

    await waitForSelector('[data-component="activity-bar"]', 10_000);
    await waitForSelector('[data-component="side-bar"][data-active-content-id="explorer"]', 10_000);
    await waitForSelector('[data-component="editor-groups-part"]', 10_000);
    await waitForSelector(`[data-action="file-tree-open-file"][data-path="${fixtureFiles[0]}"]`, 10_000);

    const fourPaneScenario = await exerciseFourPaneOpenSplitMoveScenario();
    const productionPath = collectProductionPathEvidence();
    const fatalErrors = capturedErrors.filter((message) => suspiciousMessagePattern.test(message));
    const packageImpact = {
      flexlayoutVersion: "0.9.0",
      dependencyPinned: true,
    };
    const fixtureTabsOpened = fixtureFiles.every((title) => fourPaneScenario.openedTabTitles.includes(title));
    const ok =
      fatalErrors.length === 0 &&
      productionPath.appShellMounted &&
      productionPath.editorGroupsPartMounted &&
      productionPath.editorGridProvider === "flexlayout-model" &&
      productionPath.flexlayoutProviderMatched &&
      !productionPath.legacySplitPaneBridgeMatched &&
      fixtureTabsOpened &&
      fourPaneScenario.openedTabCount === fixtureFiles.length &&
      fourPaneScenario.splitCommandCount === 3 &&
      fourPaneScenario.moveCommandCount === 1 &&
      fourPaneScenario.finalGridPaneCount === 4 &&
      fourPaneScenario.finalGridTabCount === fixtureFiles.length &&
      packageImpact.dependencyPinned;

    publishResult({
      ok,
      errors: fatalErrors,
      productionPath,
      fourPaneScenario,
      packageImpact,
      reason:
        fatalErrors[0] ??
        (!productionPath.appShellMounted ? "Production AppShell chrome did not mount." : undefined) ??
        (!productionPath.editorGroupsPartMounted ? "Production EditorGroupsPart did not mount." : undefined) ??
        (productionPath.editorGridProvider !== "flexlayout-model"
          ? `Expected production EditorGroupsPart data-editor-grid-provider=flexlayout-model, saw ${productionPath.editorGridProvider ?? "<missing>"}. T5 must wire AppShell to the production flexlayout EditorGroupsService path.`
          : undefined) ??
        (productionPath.legacySplitPaneBridgeMatched
          ? `${legacySplitPaneBridgeProvider} is still present in the production AppShell EditorGroupsPart path; T5 must remove the legacy bridge.`
          : undefined) ??
        (!fixtureTabsOpened
          ? `Expected opened tabs ${fixtureFiles.join(",")}, saw ${fourPaneScenario.openedTabTitles.join(",")}`
          : undefined) ??
        (fourPaneScenario.finalGridPaneCount !== 4
          ? `Expected 4 populated flexlayout grid panes after open/split/move scenario, saw ${fourPaneScenario.finalGridPaneCount}. T5 must replace the legacy two-pane editor bridge path with the flexlayout model.`
          : undefined) ??
        (fourPaneScenario.finalGridTabCount !== fixtureFiles.length
          ? `Expected ${fixtureFiles.length} grid tabs after scenario, saw ${fourPaneScenario.finalGridTabCount}.`
          : undefined),
    });
  } catch (error) {
    publishResult(failedResult(stringifyErrorPart(error)));
  }
}

async function exerciseFourPaneOpenSplitMoveScenario(): Promise<DockLayoutRuntimeSmokeResult["fourPaneScenario"]> {
  const operationLog: string[] = [];
  let splitCommandCount = 0;
  let moveCommandCount = 0;

  for (const filePath of fixtureFiles) {
    const button = await waitForSelector(`[data-action="file-tree-open-file"][data-path="${CSS.escape(filePath)}"]`, 10_000);
    button.click();
    await waitUntil(
      () => visibleEditorTabTitles().includes(filePath),
      10_000,
      () => `Timed out opening ${filePath}; visible tabs=${visibleEditorTabTitles().join(",")}`,
    );
    operationLog.push(`open:${filePath}`);
  }

  await activateEditorTabByTitle("delta.ts");
  for (let index = 0; index < 3; index += 1) {
    dispatchCommandShortcut("\\");
    splitCommandCount += 1;
    operationLog.push(`split-right:${index + 1}`);
    await settleFor(100);
  }

  await activateEditorTabByTitle("delta.ts");
  const moveBefore = collectPaneSignature();
  dispatchCommandShortcut("ArrowRight", { altKey: true });
  moveCommandCount += 1;
  await settleFor(150);
  operationLog.push(`move-active-right:before=${moveBefore}:after=${collectPaneSignature()}`);

  const gridSlots = collectGridSlots();
  const populatedGridSlots = gridSlots.filter((slot) => slot.groupId.length > 0 && slot.tabCount > 0);
  const legacyVisualPaneIds = collectLegacyVisualPaneIds();
  const openedTabTitles = visibleEditorTabTitles();

  return {
    fixtureFiles: [...fixtureFiles],
    openedTabTitles,
    openedTabCount: openedTabTitles.filter((title) => fixtureFiles.includes(title)).length,
    splitCommandCount,
    moveCommandCount,
    finalGridPaneCount: populatedGridSlots.length,
    finalGridTabCount: populatedGridSlots.reduce((sum, slot) => sum + slot.tabCount, 0),
    gridSlots,
    legacyVisualPaneIds,
    operationLog,
  };
}

function collectProductionPathEvidence(): DockLayoutRuntimeSmokeResult["productionPath"] {
  const editorGroupsPart = document.querySelector<HTMLElement>('[data-component="editor-groups-part"]');
  const editorGridProvider = editorGroupsPart?.dataset.editorGridProvider ?? null;

  return {
    appShellMounted:
      document.querySelector('[data-component="activity-bar"]') !== null &&
      document.querySelector('[data-component="side-bar"]') !== null &&
      document.querySelector('[data-component="bottom-panel"]') !== null,
    editorGroupsPartMounted: editorGroupsPart !== null,
    editorGridProvider,
    flexlayoutProviderMatched: document.querySelector('[data-editor-grid-provider="flexlayout-model"]') !== null,
    legacySplitPaneBridgeMatched: document.querySelector(`[data-editor-grid-provider="${legacySplitPaneBridgeProvider}"]`) !== null,
    splitEditorPaneBridgeMounted: document.querySelector('[data-component="split-editor-pane"]') !== null,
  };
}

function collectGridSlots(): DockLayoutRuntimeSmokeResult["fourPaneScenario"]["gridSlots"] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-editor-grid-slot]"))
    .map((element) => ({
      index: Number(element.dataset.editorGridSlot ?? "0"),
      groupId: element.dataset.editorGroupId ?? "",
      tabCount: Number(element.dataset.editorGroupTabCount ?? "0"),
      activeTabId: element.dataset.editorGroupActiveTabId ?? "",
    }))
    .sort((left, right) => left.index - right.index);
}

function collectLegacyVisualPaneIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-editor-split-pane]"))
    .map((element) => element.dataset.editorSplitPane ?? "")
    .filter(Boolean)
    .sort();
}

function collectPaneSignature(): string {
  const gridSignature = collectGridSlots()
    .filter((slot) => slot.groupId.length > 0 || slot.tabCount > 0 || slot.activeTabId.length > 0)
    .map((slot) => `${slot.index}:${slot.groupId}:${slot.tabCount}:${slot.activeTabId}`)
    .join("|");
  const legacySignature = collectLegacyVisualPaneIds().join("|");
  return gridSignature || `legacy:${legacySignature}`;
}

async function activateEditorTabByTitle(title: string): Promise<void> {
  await waitUntil(
    () => editorTabButtonByTitle(title) !== null,
    5_000,
    () => `Timed out waiting for editor tab ${title}; visible tabs=${visibleEditorTabTitles().join(",")}`,
  );
  editorTabButtonByTitle(title)?.click();
  await animationFrame();
}

function editorTabButtonByTitle(title: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-editor-layout-tab="true"]'))
    .filter(isVisibleElement)
    .find((button) => button.textContent?.includes(title) === true) ?? null;
}

function visibleEditorTabTitles(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-editor-layout-tab-label="true"]'))
    .filter(isVisibleElement)
    .map((element) => element.textContent?.trim() ?? "")
    .filter(Boolean)
    .sort();
}

function isVisibleElement(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    style.visibility !== "hidden" &&
    style.display !== "none"
  );
}

function dispatchCommandShortcut(key: string, modifiers: { altKey?: boolean } = {}): void {
  window.dispatchEvent(new KeyboardEvent("keydown", {
    key,
    code: key === "\\" ? "Backslash" : key,
    metaKey: true,
    altKey: modifiers.altKey === true,
    bubbles: true,
    cancelable: true,
  }));
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
          requestId: command.requestId ?? "dock-layout-search-request",
          workspaceId: command.workspaceId ?? workspaceId,
          message: "Search is disabled in dock layout smoke.",
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
      async invoke(request: { action: string; requestId?: string; workspaceId?: WorkspaceId }) {
        counters.gitInvokeActions.push(request.action);
        return {
          type: "git/lifecycle",
          action: "failed",
          requestId: request.requestId ?? `dock-layout-${request.action}`,
          workspaceId: request.workspaceId ?? workspaceId,
          message: "Git is disabled in dock layout smoke.",
          failedAt: new Date(0).toISOString(),
        };
      },
      onEvent(listener: GenericListener): Disposable {
        gitListeners.add(listener);
        return disposable(() => gitListeners.delete(listener));
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
        if (command.type === "terminal/open") {
          counters.terminalOpenCount += 1;
          return {
            type: "terminal/opened",
            tabId: `tt_${command.workspaceId ?? workspaceId}_${counters.terminalOpenCount}`,
            workspaceId: command.workspaceId ?? workspaceId,
            pid: 10_000 + counters.terminalOpenCount,
          };
        }
        if (command.type === "terminal/close") {
          return {
            type: "terminal/exited",
            tabId: command.tabId,
            workspaceId,
            reason: "user-close",
            exitCode: 0,
          };
        }
        if (command.type === "terminal/scrollback-stats/query") {
          return {
            type: "terminal/scrollback-stats/reply",
            tabId: command.tabId,
            mainBufferByteLimit: 0,
            mainBufferStoredBytes: 0,
            mainBufferDroppedBytesTotal: 0,
            xtermScrollbackLines: 0,
          };
        }
        return undefined;
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
      throw new Error(`Unexpected editor bridge request in dock layout smoke: ${request.type}`);
  }
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
    serverName: `${normalizedLanguage}-dock-layout-smoke`,
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
  return fixtureNodes.map((node) => ({ ...node }));
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
  return { dispose };
}

async function waitForSelector(selector: string, timeoutMs = 5_000): Promise<HTMLElement> {
  let latest: HTMLElement | null = null;
  await waitUntil(() => {
    latest = document.querySelector<HTMLElement>(selector);
    return latest !== null;
  }, timeoutMs, () => `Timed out waiting for selector ${selector}`);
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

function failedResult(reason: string): DockLayoutRuntimeSmokeResult {
  return {
    ok: false,
    errors: [reason],
    productionPath: {
      appShellMounted: false,
      editorGroupsPartMounted: false,
      editorGridProvider: null,
      flexlayoutProviderMatched: false,
      legacySplitPaneBridgeMatched: false,
      splitEditorPaneBridgeMounted: false,
    },
    fourPaneScenario: {
      fixtureFiles: [...fixtureFiles],
      openedTabTitles: [],
      openedTabCount: 0,
      splitCommandCount: 0,
      moveCommandCount: 0,
      finalGridPaneCount: 0,
      finalGridTabCount: 0,
      gridSlots: [],
      legacyVisualPaneIds: [],
      operationLog: [],
    },
    packageImpact: {
      flexlayoutVersion: "0.9.0",
      dependencyPinned: true,
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

function publishResult(result: DockLayoutRuntimeSmokeResult): void {
  window.__nexusDockLayoutRuntimeSmokeResult = result;
}
