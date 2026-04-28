import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";

import type { WorkspaceFileKind, WorkspaceFileTreeNode } from "../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import type { OpenSessionWorkspace } from "../../../shared/src/contracts/workspace/workspace-shell";
import { FileTreePanel } from "../../src/renderer/components/FileTreePanel";
import type { FileTreePanelProps } from "../../src/renderer/components/FileTreePanel";
import { ActivityBarPart } from "../../src/renderer/parts/activity-bar";
import { SideBarPart } from "../../src/renderer/parts/side-bar";
import {
  DEFAULT_ACTIVITY_BAR_VIEWS,
  DEFAULT_SIDE_BAR_WIDTH,
  type ActivityBarViewId,
} from "../../src/renderer/services/activity-bar-service";
import "../../src/renderer/styles.css";

interface SmokeResult {
  ok: boolean;
  errors: string[];
  toggleClicks: number;
  visiblePaths: string[];
  expandedPaths: string[];
  activityBarViewCount: number;
  sideBarActiveContentId: string | null;
  fileTreeMountedInExplorerSideBar: boolean;
  contextMenuOpened?: boolean;
  reason?: string;
}

declare global {
  interface Window {
    __nexusFileTreeFolderToggleSmokeResult?: SmokeResult;
  }
}

const workspaceId = "ws_file_tree_smoke" as WorkspaceId;
const activeWorkspace: OpenSessionWorkspace = {
  id: workspaceId,
  displayName: "Smoke Workspace",
  absolutePath: "/tmp/nexus-file-tree-smoke",
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
    name: "README.md",
    path: "README.md",
    kind: "file",
  },
];

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
  capturedErrors.push(
    stringifyErrorPart(event.error ?? event.message),
  );
});
window.addEventListener("unhandledrejection", (event) => {
  capturedErrors.push(stringifyErrorPart(event.reason));
});

function SmokeHarness(): JSX.Element {
  const [activeViewId, setActiveViewId] = useState<ActivityBarViewId>("explorer");
  const [expandedPaths, setExpandedPaths] = useState<Record<string, true>>({});
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(null);
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
    workspaceTabId: "smoke-workspace-tab",
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
    onOpenFile() {},
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
    <div data-fixture="file-tree-folder-toggle-runtime" className="flex h-full min-h-0 bg-background text-foreground">
      <div
        data-panel="workspace-strip"
        className="min-h-0 shrink-0 border-r border-border bg-card/60 p-2 text-xs text-muted-foreground"
        style={{ flexBasis: 160, width: 160 }}
      >
        Smoke Workspace
      </div>
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
        <h1 className="text-sm font-medium">Folder toggle runtime fixture center</h1>
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
    publishResult({ ok: false, errors: ["Missing #app root"], toggleClicks: 0, visiblePaths: [], expandedPaths: [] });
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
  await waitForSelector('[data-action="file-tree-toggle"][data-path="src"]');

  let toggleClicks = 0;
  for (let index = 0; index < 12; index += 1) {
    await clickToggle("src");
    toggleClicks += 1;
    await animationFrame();
  }

  await clickToggle("src");
  toggleClicks += 1;
  await waitForSelector('[data-file-tree-path="src/components"]');
  await clickToggle("src/components");
  toggleClicks += 1;
  await waitForSelector('[data-file-tree-path="src/components/Button.tsx"]');
  const contextMenuOpened = await openContextMenuForPath("src/components");

  const visiblePaths = Array.from(document.querySelectorAll<HTMLElement>("[data-file-tree-path]"))
    .map((element) => element.dataset.fileTreePath ?? "")
    .filter(Boolean);
  const expandedPaths = Array.from(document.querySelectorAll<HTMLElement>('[aria-expanded="true"][data-file-tree-path]'))
    .map((element) => element.dataset.fileTreePath ?? "")
    .filter(Boolean);
  const fatalErrors = capturedErrors.filter((message) =>
    suspiciousMessagePattern.test(message),
  );
  const sideBarActiveContentId =
    document.querySelector<HTMLElement>('[data-component="side-bar"]')?.dataset.activeContentId ?? null;
  const fileTreeMountedInExplorerSideBar = isFileTreeMountedInExplorerSideBar();

  publishResult({
    ok:
      fatalErrors.length === 0 &&
      sideBarActiveContentId === "explorer" &&
      fileTreeMountedInExplorerSideBar &&
      visiblePaths.includes("src/components/Button.tsx"),
    errors: fatalErrors,
    toggleClicks,
    visiblePaths,
    expandedPaths,
    activityBarViewCount: document.querySelectorAll("[data-activity-view]").length,
    sideBarActiveContentId,
    fileTreeMountedInExplorerSideBar,
    contextMenuOpened,
    reason:
      fatalErrors[0] ??
      (sideBarActiveContentId !== "explorer" ? `Expected Explorer Side Bar, saw ${sideBarActiveContentId ?? "none"}.` : undefined) ??
      (!fileTreeMountedInExplorerSideBar ? "FileTreePanel was not mounted inside the Explorer Side Bar." : undefined),
  });
}

function isFileTreeMountedInExplorerSideBar(): boolean {
  const sideBar = document.querySelector<HTMLElement>('[data-component="side-bar"][data-active-content-id="explorer"]');
  return sideBar?.querySelector('[data-component="file-tree-panel"]') !== null;
}

async function openContextMenuForPath(path: string): Promise<boolean> {
  const row = await waitForSelector(`[data-action="file-tree-toggle-row"][data-path="${CSS.escape(path)}"]`);
  row.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: 120,
    clientY: 120,
  }));
  await waitForSelector('[data-file-tree-context-menu="folder"]');
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await animationFrame();
  return true;
}

async function clickToggle(path: string): Promise<void> {
  const selector = `[data-action="file-tree-toggle"][data-path="${CSS.escape(path)}"]`;
  const toggle = await waitForSelector(selector);
  toggle.click();
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

function publishResult(result: SmokeResult): void {
  window.__nexusFileTreeFolderToggleSmokeResult = result;
}

runSmoke().catch((error: unknown) => {
  const sideBarActiveContentId =
    document.querySelector<HTMLElement>('[data-component="side-bar"]')?.dataset.activeContentId ?? null;
  publishResult({
    ok: false,
    errors: [stringifyErrorPart(error), ...capturedErrors],
    toggleClicks: 0,
    visiblePaths: Array.from(document.querySelectorAll<HTMLElement>("[data-file-tree-path]"))
      .map((element) => element.dataset.fileTreePath ?? "")
      .filter(Boolean),
    expandedPaths: [],
    activityBarViewCount: document.querySelectorAll("[data-activity-view]").length,
    sideBarActiveContentId,
    fileTreeMountedInExplorerSideBar: isFileTreeMountedInExplorerSideBar(),
    reason: stringifyErrorPart(error),
  });
});
