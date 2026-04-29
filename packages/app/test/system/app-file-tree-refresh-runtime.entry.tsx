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
type EditorListener = (event: unknown) => void;
type GenericListener = (event: unknown) => void;

interface IconStabilityEvent {
  phase: string;
  path: string;
  source: string;
  state: string;
  elementId: number;
}

interface IconIdentityChange {
  phase: string;
  path: string;
  previousElementId: number;
  nextElementId: number;
  previousSource: string;
  nextSource: string;
}

interface AppFileTreeRefreshSmokeResult {
  ok: boolean;
  errors: string[];
  allowedErrors: string[];
  iconLoadingEvents: IconStabilityEvent[];
  iconLoadingEventCount: number;
  iconIdentityChanges: IconIdentityChange[];
  iconIdentityChangeCount: number;
  monacoWorkerMessages: string[];
  treeReadCount: number;
  watchEventCount: number;
  terminalOpenCount: number;
  gitInvokeActions: string[];
  visiblePathSamples: string[][];
  visiblePaths: string[];
  expandedPaths: string[];
  sourceControlErrorSeen: boolean;
  sourceControlRouteExercised: boolean;
  explorerSideBarRestored: boolean;
  fileTreeMountedInExplorerSideBar: boolean;
  contextMenuOpened: boolean;
  reason?: string;
}

declare global {
  interface Window {
    __nexusAppFileTreeRefreshSmokeResult?: AppFileTreeRefreshSmokeResult;
  }
}

const resultGlobalName = "__nexusAppFileTreeRefreshSmokeResult";
const workspaceId = "ws_app_file_tree_refresh_smoke" as WorkspaceId;
const workspaceRoot = "/tmp/nexus-app-file-tree-refresh-smoke";
const activeWorkspace: OpenSessionWorkspace = {
  id: workspaceId,
  displayName: "Smoke Workspace",
  absolutePath: workspaceRoot,
};
const sidebarState: WorkspaceSidebarState = {
  openWorkspaces: [activeWorkspace],
  activeWorkspaceId: workspaceId,
};
const suspiciousMessagePattern =
  /Maximum update depth exceeded|An error occurred in the <(?:Presence|PopperAnchor|FileIcon)> component|<Presence>|<PopperAnchor>|<FileIcon>|getSnapshot should be cached|Could not create web worker|MonacoEnvironment\.getWorker|MonacoEnvironment\.getWorkerUrl|worker_file|ts\.worker|json\.worker|Falling back to loading web worker code in main thread|Uncaught \[object Event\]|Uncaught Event/i;
const monacoWorkerMessagePattern =
  /Could not create web worker|MonacoEnvironment\.getWorker|MonacoEnvironment\.getWorkerUrl|worker_file|ts\.worker|json\.worker|Falling back to loading web worker code in main thread|Uncaught \[object Event\]|Uncaught Event/i;
const allowedSourceControlFailurePattern = /Source Control: failed to initialize git state\.|sidecar exited before READY/i;
const capturedConsoleMessages: string[] = [];
const capturedErrors: string[] = [];
const allowedErrors: string[] = [];
const editorListeners = new Set<EditorListener>();
const workspaceListeners = new Set<(state: WorkspaceSidebarState) => void>();
const harnessListeners = new Set<GenericListener>();
const searchListeners = new Set<GenericListener>();
const gitListeners = new Set<GenericListener>();
const terminalListeners = new Set<GenericListener>();
const claudeConsentListeners = new Set<GenericListener>();
const counters = {
  treeReadCount: 0,
  watchEventCount: 0,
  terminalOpenCount: 0,
  gitInvokeActions: [] as string[],
};

const fixtureNodes: WorkspaceFileTreeNode[] = [
  {
    name: "src",
    path: "src",
    kind: "directory",
    children: [
      {
        name: "components",
        path: "src/components",
        kind: "directory",
        children: [
          {
            name: "Button.tsx",
            path: "src/components/Button.tsx",
            kind: "file",
          },
          {
            name: "FileIcon.tsx",
            path: "src/components/FileIcon.tsx",
            kind: "file",
          },
        ],
      },
      {
        name: "index.ts",
        path: "src/index.ts",
        kind: "file",
      },
    ],
  },
  {
    name: "package.json",
    path: "package.json",
    kind: "file",
  },
  {
    name: "README.md",
    path: "README.md",
    kind: "file",
  },
];

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

    document.documentElement.style.width = "1280px";
    document.documentElement.style.height = "900px";
    document.body.style.width = "1280px";
    document.body.style.height = "900px";
    document.body.style.margin = "0";
    rootElement.style.width = "1280px";
    rootElement.style.height = "900px";

    const { default: App } = await import("../../src/renderer/App");
    createRoot(rootElement).render(createElement(StrictMode, null, createElement(App)));

    await waitForSelector('[data-component="activity-bar"]', 10_000);
    await waitForSelector('[data-component="side-bar"][data-active-content-id="explorer"]', 10_000);
    await waitForSelector('[data-action="file-tree-toggle"][data-path="src"]', 10_000);
    await clickToggle("src");
    await waitForSelector('[data-file-tree-path="src/components"]');
    await clickToggle("src/components");
    await waitForSelector('[data-file-tree-path="src/components/Button.tsx"]');
    await waitForNoLoadingFileIcons();

    await clickToggle("src/components");
    await waitForNoLoadingFileIcons();
    await clickToggle("src/components");
    await waitForSelector('[data-file-tree-path="src/components/Button.tsx"]');
    await waitForNoLoadingFileIcons();

    const sourceControlRouteExercised = await exerciseSourceControlRoute();
    const explorerSideBarRestored =
      document.querySelector<HTMLElement>('[data-component="side-bar"]')?.dataset.activeContentId === "explorer";
    const fileTreeMountedInExplorerSideBar = isFileTreeMountedInExplorerSideBar();
    await waitForSelector('[data-file-tree-path="src/components/Button.tsx"]');
    await waitForNoLoadingFileIcons();

    const iconStabilityProbe = createIconStabilityProbe();
    iconStabilityProbe.sample("before-warm-toggle-cycles");
    for (let index = 0; index < 4; index += 1) {
      await clickToggle("src/components");
      iconStabilityProbe.sample(`after-components-collapse-${index}`);
      await animationFrame();
      await clickToggle("src/components");
      await waitForSelector('[data-file-tree-path="src/components/Button.tsx"]');
      iconStabilityProbe.sample(`after-components-expand-${index}`);
      await animationFrame();
    }

    const visiblePathSamples: string[][] = [];
    visiblePathSamples.push(visibleFileTreePaths());

    for (let index = 0; index < 8; index += 1) {
      emitWorkspaceFileWatch(index);
      await waitUntil(() => counters.treeReadCount >= index + 2, 1_000).catch(() => undefined);
      iconStabilityProbe.sample(`after-watch-refresh-${index}`);
      await animationFrame();
      visiblePathSamples.push(visibleFileTreePaths());
    }

    await settleFor(600);
    iconStabilityProbe.sample("after-refresh-settle");
    visiblePathSamples.push(visibleFileTreePaths());

    const contextMenuOpened = await openContextMenuForPath("src/components");
    await openFile("src/components/Button.tsx");
    await waitForSelector('[data-component="monaco-editor-host"][data-file-path="src/components/Button.tsx"]', 10_000);
    await settleFor(1_200);
    iconStabilityProbe.stop();

    const visiblePaths = visibleFileTreePaths();
    const expandedPaths = expandedFileTreePaths();
    const fatalErrors = capturedErrors.filter((message) => suspiciousMessagePattern.test(message));
    const monacoWorkerMessages = capturedConsoleMessages.filter((message) => monacoWorkerMessagePattern.test(message));
    const sourceControlErrorSeen = allowedErrors.some((message) => allowedSourceControlFailurePattern.test(message));
    const nestedPathStayedVisible = visiblePathSamples.every((sample) => sample.includes("src/components/Button.tsx"));
    const refreshCountReachedWatchBurst = counters.treeReadCount >= counters.watchEventCount + 1;
    const refreshCountIsBounded = counters.treeReadCount <= 24;
    const iconLoadingEventCount = iconStabilityProbe.loadingEvents.length;
    const iconIdentityChangeCount = iconStabilityProbe.identityChanges.length;
    const iconLoadingEvents = iconStabilityProbe.loadingEvents.slice(0, 20);
    const iconIdentityChanges = iconStabilityProbe.identityChanges.slice(0, 20);

    publishResult({
      ok:
        fatalErrors.length === 0 &&
        iconLoadingEventCount === 0 &&
        monacoWorkerMessages.length === 0 &&
        nestedPathStayedVisible &&
        refreshCountReachedWatchBurst &&
        refreshCountIsBounded &&
        visiblePaths.includes("src/components/Button.tsx") &&
        expandedPaths.includes("src") &&
        expandedPaths.includes("src/components") &&
        sourceControlRouteExercised &&
        sourceControlErrorSeen &&
        explorerSideBarRestored &&
        fileTreeMountedInExplorerSideBar &&
        contextMenuOpened,
      errors: fatalErrors,
      allowedErrors,
      iconLoadingEvents,
      iconLoadingEventCount,
      iconIdentityChanges,
      iconIdentityChangeCount,
      monacoWorkerMessages,
      treeReadCount: counters.treeReadCount,
      watchEventCount: counters.watchEventCount,
      terminalOpenCount: counters.terminalOpenCount,
      gitInvokeActions: counters.gitInvokeActions,
      visiblePathSamples,
      visiblePaths,
      expandedPaths,
      sourceControlErrorSeen,
      sourceControlRouteExercised,
      explorerSideBarRestored,
      fileTreeMountedInExplorerSideBar,
      contextMenuOpened,
      reason:
        fatalErrors[0] ??
        (iconLoadingEvents[0]
          ? `File icon entered loading after warm-up: ${iconLoadingEvents[0].path} during ${iconLoadingEvents[0].phase}`
          : undefined) ??
        monacoWorkerMessages[0] ??
        (!nestedPathStayedVisible ? "Nested file path disappeared during refresh burst." : undefined) ??
        (!refreshCountReachedWatchBurst
          ? `File tree refresh did not follow watch burst: reads=${counters.treeReadCount}, watches=${counters.watchEventCount}`
          : undefined) ??
        (!refreshCountIsBounded ? `File tree refreshed too many times: ${counters.treeReadCount}` : undefined) ??
        (!sourceControlRouteExercised ? "Activity Bar Source Control route was not exercised." : undefined) ??
        (!sourceControlErrorSeen ? "Expected source-control sidecar failure was not exercised." : undefined),
    });
  } catch (error) {
    publishResult(failedResult(stringifyErrorPart(error)));
  }
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
          requestId: command.requestId ?? "search-smoke-request",
          workspaceId: command.workspaceId ?? workspaceId,
          message: "Search is disabled in smoke.",
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
      async invoke(request: { action: string }) {
        counters.gitInvokeActions.push(request.action);
        throw new Error("sidecar exited before READY");
      },
      onEvent(listener: GenericListener): Disposable {
        gitListeners.add(listener);
        return disposable(() => gitListeners.delete(listener));
      },
    },
    nexusFileActions: {
      async invoke(request: { type: string; [key: string]: unknown }) {
        return handleFileActionInvoke(request);
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
            tabId: `tt_${command.workspaceId ?? workspaceId}_smoke_${counters.terminalOpenCount}`,
            workspaceId: command.workspaceId ?? workspaceId,
            pid: 1000 + counters.terminalOpenCount,
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
        content: "export const smoke = true;\n",
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
      throw new Error(`Unexpected editor bridge request in smoke: ${request.type}`);
  }
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
    serverName: `${normalizedLanguage}-smoke`,
    message: null,
    updatedAt: new Date(0).toISOString(),
  };
}

function handleFileActionInvoke(request: { type: string; [key: string]: unknown }): unknown {
  if (request.type === "file-actions/external-drag-in") {
    return {
      type: "file-actions/external-drag-in/result",
      workspaceId: request.workspaceId ?? workspaceId,
      targetDirectory: request.targetDirectory ?? null,
      copied: [],
      collisions: [],
      largeFiles: [],
      completedAt: new Date(0).toISOString(),
    };
  }
  if (request.type === "file-actions/clipboard/paste") {
    return {
      type: "file-actions/clipboard/paste/result",
      workspaceId: request.workspaceId ?? workspaceId,
      targetDirectory: request.targetDirectory ?? null,
      operation: request.operation ?? "copy",
      applied: [],
      collisions: [],
      completedAt: new Date(0).toISOString(),
    };
  }
  return {
    type: `${request.type}/result`,
    workspaceId: request.workspaceId ?? workspaceId,
    path: request.path ?? null,
    ok: true,
  };
}

function installConsoleCapture(): void {
  const originalConsoleError = console.error.bind(console);
  const originalConsoleWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    const message = args.map(stringifyErrorPart).join(" ");
    capturedConsoleMessages.push(message);
    if (allowedSourceControlFailurePattern.test(message)) {
      allowedErrors.push(message);
    } else {
      capturedErrors.push(message);
    }
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

function emitWorkspaceFileWatch(index: number): void {
  counters.watchEventCount += 1;
  const event = {
    type: "workspace-files/watch",
    workspaceId,
    path: index % 2 === 0 ? "src/index.ts" : "src/components/Button.tsx",
    kind: "file",
    change: "changed",
    occurredAt: new Date(index).toISOString(),
  };
  for (const listener of editorListeners) {
    listener(event);
  }
}

async function clickToggle(path: string): Promise<void> {
  const selector = `[data-action="file-tree-toggle"][data-path="${CSS.escape(path)}"]`;
  const toggle = await waitForSelector(selector);
  toggle.click();
  await animationFrame();
}

async function openFile(path: string): Promise<void> {
  const selector = `[data-action="file-tree-open-file"][data-path="${CSS.escape(path)}"]`;
  const button = await waitForSelector(selector);
  button.click();
  await animationFrame();
}

async function openContextMenuForPath(path: string): Promise<boolean> {
  const row = await waitForSelector(`[data-action="file-tree-toggle-row"][data-path="${CSS.escape(path)}"]`);
  row.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: 180,
    clientY: 180,
  }));
  await waitForSelector('[data-file-tree-context-menu="folder"]');
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await animationFrame();
  return true;
}

async function exerciseSourceControlRoute(): Promise<boolean> {
  const sourceControlButton = await waitForSelector('[data-activity-view="source-control"]');
  sourceControlButton.click();
  await waitForSelector('[data-component="side-bar"][data-active-content-id="source-control"]');
  await waitForSelector('[data-component="source-control-panel"]');
  await waitUntil(
    () =>
      allowedErrors.some((message) => allowedSourceControlFailurePattern.test(message)) &&
      ["status", "branch_list", "watch_start"].every((action) => counters.gitInvokeActions.includes(action)),
    3_000,
  ).catch(() => undefined);

  const sourceControlRouteActive =
    document.querySelector<HTMLElement>('[data-component="side-bar"]')?.dataset.activeContentId === "source-control";
  const sourceControlPanelMounted = document.querySelector('[data-component="source-control-panel"]') !== null;

  const explorerButton = await waitForSelector('[data-activity-view="explorer"]');
  explorerButton.click();
  await waitForSelector('[data-component="side-bar"][data-active-content-id="explorer"]');
  await waitForSelector('[data-component="file-tree-panel"]');

  return sourceControlRouteActive && sourceControlPanelMounted;
}

function isFileTreeMountedInExplorerSideBar(): boolean {
  const sideBar = document.querySelector<HTMLElement>('[data-component="side-bar"][data-active-content-id="explorer"]');
  return sideBar?.querySelector('[data-component="file-tree-panel"]') !== null;
}

function visibleFileTreePaths(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-file-tree-path]"))
    .map((element) => element.dataset.fileTreePath ?? "")
    .filter(Boolean);
}

function expandedFileTreePaths(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[aria-expanded="true"][data-file-tree-path]'))
    .map((element) => element.dataset.fileTreePath ?? "")
    .filter(Boolean);
}

async function waitForNoLoadingFileIcons(timeoutMs = 5_000): Promise<void> {
  await waitUntil(() => loadingFileIconEvents("wait-for-no-loading").length === 0, timeoutMs);
}

function createIconStabilityProbe(): {
  loadingEvents: IconStabilityEvent[];
  identityChanges: IconIdentityChange[];
  sample(phase: string): void;
  stop(): void;
} {
  const loadingEvents: IconStabilityEvent[] = [];
  const identityChanges: IconIdentityChange[] = [];
  const elementIds = new WeakMap<Element, number>();
  const iconByPath = new Map<string, { element: Element; elementId: number; source: string }>();
  let nextElementId = 1;
  let active = true;

  const elementIdFor = (element: Element): number => {
    const existing = elementIds.get(element);
    if (existing) {
      return existing;
    }
    const nextId = nextElementId;
    nextElementId += 1;
    elementIds.set(element, nextId);
    return nextId;
  };

  const sample = (phase: string): void => {
    if (!active) {
      return;
    }

    for (const row of fileTreeRowsWithIcons()) {
      const elementId = elementIdFor(row.icon);
      const source = row.icon.dataset.fileIconSource ?? "";
      const state = row.icon.dataset.fileIconState ?? "";
      const previous = iconByPath.get(row.path);
      if (previous && previous.element !== row.icon) {
        identityChanges.push({
          phase,
          path: row.path,
          previousElementId: previous.elementId,
          nextElementId: elementId,
          previousSource: previous.source,
          nextSource: source,
        });
      }
      iconByPath.set(row.path, { element: row.icon, elementId, source });

      if (state === "loading") {
        loadingEvents.push({
          phase,
          path: row.path,
          source,
          state,
          elementId,
        });
      }
    }
  };

  const observer = new MutationObserver(() => {
    sample("mutation");
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-file-icon-state", "data-file-icon-source"],
  });
  sample("probe-start");

  return {
    loadingEvents,
    identityChanges,
    sample,
    stop() {
      active = false;
      observer.disconnect();
    },
  };
}

function loadingFileIconEvents(phase: string): IconStabilityEvent[] {
  return fileTreeRowsWithIcons()
    .filter((row) => row.icon.dataset.fileIconState === "loading")
    .map((row, index) => ({
      phase,
      path: row.path,
      source: row.icon.dataset.fileIconSource ?? "",
      state: row.icon.dataset.fileIconState ?? "",
      elementId: index + 1,
    }));
}

function fileTreeRowsWithIcons(): Array<{ path: string; icon: HTMLElement }> {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-file-tree-path]"))
    .map((row) => {
      const path = row.dataset.fileTreePath ?? "";
      const icon = row.querySelector<HTMLElement>('[data-file-icon="true"]');
      return path && icon ? { path, icon } : null;
    })
    .filter((row): row is { path: string; icon: HTMLElement } => row !== null);
}

async function waitForSelector(selector: string, timeoutMs = 5_000): Promise<HTMLElement> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) {
      return element;
    }
    await animationFrame();
  }
  throw new Error(`Timed out waiting for selector: ${selector}`);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await animationFrame();
  }
  throw new Error("Timed out waiting for condition.");
}

async function settleFor(durationMs: number): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < durationMs) {
    await animationFrame();
  }
}

function animationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function cloneFixtureNodes(): WorkspaceFileTreeNode[] {
  return JSON.parse(JSON.stringify(fixtureNodes)) as WorkspaceFileTreeNode[];
}

function cloneSidebarState(): WorkspaceSidebarState {
  return {
    activeWorkspaceId: sidebarState.activeWorkspaceId,
    openWorkspaces: sidebarState.openWorkspaces.map((workspace) => ({ ...workspace })),
  };
}

function disposable(dispose: () => void): Disposable {
  return { dispose };
}

function failedResult(reason: string): AppFileTreeRefreshSmokeResult {
  return {
    ok: false,
    errors: [...capturedErrors, reason],
    allowedErrors,
    iconLoadingEvents: [],
    iconLoadingEventCount: 0,
    iconIdentityChanges: [],
    iconIdentityChangeCount: 0,
    monacoWorkerMessages: capturedConsoleMessages.filter((message) => monacoWorkerMessagePattern.test(message)),
    treeReadCount: counters.treeReadCount,
    watchEventCount: counters.watchEventCount,
    terminalOpenCount: counters.terminalOpenCount,
    gitInvokeActions: counters.gitInvokeActions,
    visiblePathSamples: [],
    visiblePaths: visibleFileTreePaths(),
    expandedPaths: expandedFileTreePaths(),
    sourceControlErrorSeen: allowedErrors.some((message) => allowedSourceControlFailurePattern.test(message)),
    sourceControlRouteExercised: false,
    explorerSideBarRestored:
      document.querySelector<HTMLElement>('[data-component="side-bar"]')?.dataset.activeContentId === "explorer",
    fileTreeMountedInExplorerSideBar: isFileTreeMountedInExplorerSideBar(),
    contextMenuOpened: false,
    reason,
  };
}

function publishResult(result: AppFileTreeRefreshSmokeResult): void {
  window[resultGlobalName] = result;
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
