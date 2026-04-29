import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";

import type { WorkspaceFileKind, WorkspaceFileTreeNode } from "../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import type { OpenSessionWorkspace } from "../../../shared/src/contracts/workspace/workspace-shell";
import { FileTreePanel, type FileTreePanelProps } from "../../src/renderer/components/FileTreePanel";
import { ActivityBarPart } from "../../src/renderer/parts/activity-bar";
import { SideBarPart } from "../../src/renderer/parts/side-bar";
import {
  DEFAULT_ACTIVITY_BAR_VIEWS,
  DEFAULT_SIDE_BAR_WIDTH,
  type ActivityBarViewId,
} from "../../src/renderer/services/activity-bar-service";
import "../../src/renderer/styles.css";

interface SelectionCheck {
  iteration: number;
  expectedPath: string;
  actualPath: string | null;
  selectedDomPath: string | null;
  activeDomPath: string | null;
  matched: boolean;
}

interface TabEntryCheck {
  previousSelectedPath: string | null;
  attemptedFocusPath: string;
  selectedPathAfterEntry: string | null;
  activeDomPathAfterEntry: string | null;
  restored: boolean;
}

interface SmokeResult {
  ok: boolean;
  errors: string[];
  iterations: number;
  selectionMatches: number;
  selectionChecks: SelectionCheck[];
  tabEntryCheck: TabEntryCheck | null;
  openedPaths: string[];
  activityBarViewCount: number;
  sideBarActiveContentId: string | null;
  fileTreeMountedInExplorerSideBar: boolean;
  reason?: string;
}

declare global {
  interface Window {
    __nexusFileTreeClickResilienceSmokeResult?: SmokeResult;
  }
}

const workspaceId = "ws_file_tree_click_resilience" as WorkspaceId;
const activeWorkspace: OpenSessionWorkspace = {
  id: workspaceId,
  displayName: "Click Resilience Workspace",
  absolutePath: "/tmp/nexus-file-tree-click-resilience",
};

const fixtureNodes: WorkspaceFileTreeNode[] = [
  {
    name: "README.md",
    path: "README.md",
    kind: "file",
  },
  {
    name: "package.json",
    path: "package.json",
    kind: "file",
  },
  {
    name: "src",
    path: "src",
    kind: "directory",
    children: [
      {
        name: "index.ts",
        path: "src/index.ts",
        kind: "file",
      },
    ],
  },
];

const CLICK_ITERATIONS = 20;
const CLICK_SEQUENCE = Array.from({ length: CLICK_ITERATIONS }, (_value, index) =>
  index % 2 === 0 ? "README.md" : "package.json",
);
const capturedErrors: string[] = [];
const suspiciousMessagePattern =
  /Maximum update depth exceeded|An error occurred in the <(?:Presence|PopperAnchor|FileIcon)> component|<Presence>|<PopperAnchor>|<FileIcon>|getSnapshot should be cached/i;
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

function SmokeHarness(): JSX.Element {
  const [activeViewId, setActiveViewId] = useState<ActivityBarViewId>("explorer");
  const [expandedPaths, setExpandedPaths] = useState<Record<string, true>>({ src: true });
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>("README.md");
  const [openedPaths, setOpenedPaths] = useState<string[]>([]);
  const activeView = DEFAULT_ACTIVITY_BAR_VIEWS.find((view) => view.id === activeViewId) ?? DEFAULT_ACTIVITY_BAR_VIEWS[0]!;
  const sideBarRoute = {
    title: activeView.sideBarTitle,
    contentId: activeView.sideBarContentId,
  };

  const toggleDirectory = useCallback((path: string) => {
    setExpandedPaths((current) => {
      const next = { ...current };
      if (next[path]) {
        delete next[path];
      } else {
        next[path] = true;
      }
      return next;
    });
  }, []);

  const noopFileAction = useCallback((_workspaceId: WorkspaceId, _path: string, _kind: WorkspaceFileKind) => {}, []);
  const noopRenameAction = useCallback((_workspaceId: WorkspaceId, _oldPath: string, _newPath: string) => {}, []);

  const props: FileTreePanelProps = {
    activeWorkspace,
    workspaceTabId: "click-resilience-workspace-tab",
    fileTree: {
      workspaceId,
      rootPath: activeWorkspace.absolutePath,
      nodes: fixtureNodes,
      loading: false,
      errorMessage: null,
      readAt: new Date(0).toISOString(),
    },
    expandedPaths,
    gitBadgeByPath: {},
    selectedTreePath,
    pendingExplorerEdit: null,
    pendingExplorerDelete: null,
    onRefresh() {},
    onToggleDirectory: toggleDirectory,
    onOpenFile(_workspaceId, path) {
      setOpenedPaths((current) => [...current, path]);
    },
    onCreateNode: noopFileAction,
    onDeleteNode: noopFileAction,
    onRenameNode: noopRenameAction,
    onSelectTreePath: setSelectedTreePath,
    onBeginCreateFile() {},
    onBeginCreateFolder() {},
    onBeginRename() {},
    onBeginDelete() {},
    onCancelExplorerEdit() {},
    onCollapseAll() {
      setExpandedPaths({});
    },
    onMoveTreeSelection() {},
  };

  return (
    <div data-fixture="file-tree-click-resilience-runtime" className="flex h-full min-h-0 bg-background text-foreground">
      <ActivityBarPart
        views={DEFAULT_ACTIVITY_BAR_VIEWS}
        activeViewId={activeViewId}
        sideBarCollapsed={false}
        onActiveViewChange={(viewId) => setActiveViewId(viewId)}
      />
      <div
        data-panel="side-bar"
        className="min-h-0 shrink-0 overflow-hidden"
        style={{ flexBasis: DEFAULT_SIDE_BAR_WIDTH, width: DEFAULT_SIDE_BAR_WIDTH }}
      >
        <SideBarPart
          route={sideBarRoute}
          explorer={<FileTreePanel {...props} />}
          search={<SideBarStub label="Search" />}
          sourceControl={<SideBarStub label="Source Control" />}
          tool={<SideBarStub label="Tool" />}
          session={<SideBarStub label="Session" />}
          preview={<SideBarStub label="Preview" />}
        />
      </div>
      <main data-panel="center" className="min-h-0 min-w-0 flex-1 p-4">
        <button
          type="button"
          data-action="external-focus-target"
          className="rounded border border-border px-3 py-2 text-sm"
        >
          External focus target
        </button>
        <div
          data-selected-path={selectedTreePath ?? ""}
          data-opened-paths={openedPaths.join("|")}
          className="mt-3 text-xs text-muted-foreground"
        >
          Selected: {selectedTreePath ?? "none"}
        </div>
      </main>
    </div>
  );
}

function SideBarStub({ label }: { label: string }): JSX.Element {
  return (
    <section data-sidebar-stub={label.toLowerCase().replaceAll(" ", "-")} className="p-3 text-sm">
      {label} fixture content
    </section>
  );
}

async function runSmoke(): Promise<void> {
  const rootElement = document.getElementById("app");
  if (!rootElement) {
    publishResult(emptyFailure(["Missing #app root"]));
    return;
  }

  document.documentElement.style.width = "1000px";
  document.documentElement.style.height = "800px";
  document.body.style.width = "1000px";
  document.body.style.height = "800px";
  document.body.style.margin = "0";
  rootElement.style.width = "1000px";
  rootElement.style.height = "800px";

  createRoot(rootElement).render(
    <StrictMode>
      <SmokeHarness />
    </StrictMode>,
  );

  await waitForSelector('[data-component="activity-bar"]');
  await waitForSelector('[data-component="side-bar"][data-active-content-id="explorer"]');
  await waitForSelector('[data-component="file-tree-panel"]');
  await waitForSelector('[data-action="file-tree-open-file"][data-path="README.md"]');
  await waitForSelectedPath("README.md");

  const externalFocusTarget = await waitForSelector('[data-action="external-focus-target"]');
  const selectionChecks: SelectionCheck[] = [];

  for (const [iteration, expectedPath] of CLICK_SEQUENCE.entries()) {
    await pointerClick(externalFocusTarget);
    await waitUntil(() => document.activeElement === externalFocusTarget, `external focus before iteration ${iteration + 1}`);

    const rowButton = await waitForSelector(`[data-action="file-tree-open-file"][data-path="${CSS.escape(expectedPath)}"]`);
    await pointerClick(rowButton);
    const actualPath = await waitForSelectedPath(expectedPath);
    const selectedDomPath = selectedDomPathInTree();
    const activeDomPath = activeFileTreePath();

    selectionChecks.push({
      iteration: iteration + 1,
      expectedPath,
      actualPath,
      selectedDomPath,
      activeDomPath,
      matched: actualPath === expectedPath && selectedDomPath === expectedPath,
    });
  }

  const previousSelectedPath = selectedPathFromState();
  await pointerClick(externalFocusTarget);
  await waitUntil(() => document.activeElement === externalFocusTarget, "external focus before Tab entry restore");
  externalFocusTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  const attemptedFocusRow =
    document.querySelector<HTMLElement>('[data-file-tree-path][tabindex="0"]') ??
    (await waitForSelector(`[data-file-tree-path="${CSS.escape(previousSelectedPath ?? "")}"]`));
  const attemptedFocusPath = attemptedFocusRow.dataset.fileTreePath ?? "";
  attemptedFocusRow.focus();
  await waitForActiveFileTreePath(previousSelectedPath);
  const tabEntryCheck: TabEntryCheck = {
    previousSelectedPath,
    attemptedFocusPath,
    selectedPathAfterEntry: selectedPathFromState(),
    activeDomPathAfterEntry: activeFileTreePath(),
    restored: selectedPathFromState() === previousSelectedPath && activeFileTreePath() === previousSelectedPath,
  };

  const fatalErrors = capturedErrors.filter((message) => suspiciousMessagePattern.test(message));
  const sideBarActiveContentId =
    document.querySelector<HTMLElement>('[data-component="side-bar"]')?.dataset.activeContentId ?? null;
  const fileTreeMountedInExplorerSideBar = isFileTreeMountedInExplorerSideBar();
  const selectionMatches = selectionChecks.filter((check) => check.matched).length;
  const ok =
    fatalErrors.length === 0 &&
    sideBarActiveContentId === "explorer" &&
    fileTreeMountedInExplorerSideBar &&
    selectionMatches === CLICK_ITERATIONS &&
    tabEntryCheck.restored;

  publishResult({
    ok,
    errors: fatalErrors,
    iterations: CLICK_ITERATIONS,
    selectionMatches,
    selectionChecks,
    tabEntryCheck,
    openedPaths: openedPathsFromState(),
    activityBarViewCount: document.querySelectorAll("[data-activity-view]").length,
    sideBarActiveContentId,
    fileTreeMountedInExplorerSideBar,
    reason:
      fatalErrors[0] ??
      (selectionMatches !== CLICK_ITERATIONS
        ? `Expected ${CLICK_ITERATIONS} selection matches, saw ${selectionMatches}.`
        : undefined) ??
      (!tabEntryCheck.restored ? "Programmatic Tab-entry focus did not restore the previous selected tree path." : undefined) ??
      (sideBarActiveContentId !== "explorer" ? `Expected Explorer Side Bar, saw ${sideBarActiveContentId ?? "none"}.` : undefined) ??
      (!fileTreeMountedInExplorerSideBar ? "FileTreePanel was not mounted inside the Explorer Side Bar." : undefined),
  });
}

function isFileTreeMountedInExplorerSideBar(): boolean {
  const sideBar = document.querySelector<HTMLElement>('[data-component="side-bar"][data-active-content-id="explorer"]');
  return sideBar?.querySelector('[data-component="file-tree-panel"]') !== null;
}

async function pointerClick(element: HTMLElement): Promise<void> {
  const rect = element.getBoundingClientRect();
  const clientX = Math.max(1, Math.round(rect.left + Math.min(rect.width / 2, 12)));
  const clientY = Math.max(1, Math.round(rect.top + Math.min(rect.height / 2, 12)));

  element.dispatchEvent(new PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX,
    clientY,
  }));
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX, clientY }));
  element.focus();
  element.dispatchEvent(new PointerEvent("pointerup", {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 0,
    clientX,
    clientY,
  }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, buttons: 0, clientX, clientY }));
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, clientX, clientY }));
  await animationFrame();
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

async function waitForSelectedPath(expectedPath: string | null, timeoutMs = 5_000): Promise<string | null> {
  await waitUntil(
    () => selectedPathFromState() === expectedPath,
    `selected path ${expectedPath ?? "none"}`,
    timeoutMs,
  );
  return selectedPathFromState();
}

async function waitForActiveFileTreePath(expectedPath: string | null, timeoutMs = 5_000): Promise<string | null> {
  await waitUntil(
    () => activeFileTreePath() === expectedPath,
    `active file-tree path ${expectedPath ?? "none"}`,
    timeoutMs,
  );
  return activeFileTreePath();
}

async function waitUntil(predicate: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await animationFrame();
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function selectedPathFromState(): string | null {
  return document.querySelector<HTMLElement>("[data-selected-path]")?.dataset.selectedPath || null;
}

function openedPathsFromState(): string[] {
  return (document.querySelector<HTMLElement>("[data-opened-paths]")?.dataset.openedPaths ?? "")
    .split("|")
    .filter(Boolean);
}

function selectedDomPathInTree(): string | null {
  return document.querySelector<HTMLElement>('[data-file-tree-path][data-selected="true"]')?.dataset.fileTreePath ?? null;
}

function activeFileTreePath(): string | null {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) {
    return null;
  }
  return activeElement.closest<HTMLElement>("[data-file-tree-path]")?.dataset.fileTreePath ?? null;
}

function animationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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

function emptyFailure(errors: string[]): SmokeResult {
  return {
    ok: false,
    errors,
    iterations: 0,
    selectionMatches: 0,
    selectionChecks: [],
    tabEntryCheck: null,
    openedPaths: [],
    activityBarViewCount: 0,
    sideBarActiveContentId: null,
    fileTreeMountedInExplorerSideBar: false,
    reason: errors[0],
  };
}

function publishResult(result: SmokeResult): void {
  window.__nexusFileTreeClickResilienceSmokeResult = result;
}

runSmoke().catch((error: unknown) => {
  const sideBarActiveContentId =
    document.querySelector<HTMLElement>('[data-component="side-bar"]')?.dataset.activeContentId ?? null;
  publishResult({
    ok: false,
    errors: [stringifyErrorPart(error), ...capturedErrors],
    iterations: CLICK_ITERATIONS,
    selectionMatches: 0,
    selectionChecks: [],
    tabEntryCheck: null,
    openedPaths: openedPathsFromState(),
    activityBarViewCount: document.querySelectorAll("[data-activity-view]").length,
    sideBarActiveContentId,
    fileTreeMountedInExplorerSideBar: isFileTreeMountedInExplorerSideBar(),
    reason: stringifyErrorPart(error),
  });
});
