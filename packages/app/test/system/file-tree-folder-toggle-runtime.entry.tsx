import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";

import type { WorkspaceFileKind, WorkspaceFileTreeNode } from "../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import type { OpenSessionWorkspace } from "../../../shared/src/contracts/workspace/workspace-shell";
import { FileTreePanel } from "../../src/renderer/components/FileTreePanel";
import type { FileTreePanelProps } from "../../src/renderer/components/FileTreePanel";

interface SmokeResult {
  ok: boolean;
  errors: string[];
  toggleClicks: number;
  visiblePaths: string[];
  expandedPaths: string[];
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
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);

console.error = (...args: unknown[]) => {
  capturedErrors.push(args.map(stringifyErrorPart).join(" "));
  originalConsoleError(...args);
};
console.warn = (...args: unknown[]) => {
  const message = args.map(stringifyErrorPart).join(" ");
  if (/Maximum update depth exceeded|<Presence>|Presence|getSnapshot should be cached/i.test(message)) {
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
  const [expandedPaths, setExpandedPaths] = useState<Record<string, true>>({});
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(null);

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

  return <FileTreePanel {...props} />;
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
    /Maximum update depth exceeded|<Presence>|Presence|getSnapshot should be cached/i.test(message),
  );

  publishResult({
    ok: fatalErrors.length === 0 && visiblePaths.includes("src/components/Button.tsx"),
    errors: fatalErrors,
    toggleClicks,
    visiblePaths,
    expandedPaths,
    contextMenuOpened,
    reason: fatalErrors[0] ?? undefined,
  });
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
  publishResult({
    ok: false,
    errors: [stringifyErrorPart(error), ...capturedErrors],
    toggleClicks: 0,
    visiblePaths: Array.from(document.querySelectorAll<HTMLElement>("[data-file-tree-path]"))
      .map((element) => element.dataset.fileTreePath ?? "")
      .filter(Boolean),
    expandedPaths: [],
    reason: stringifyErrorPart(error),
  });
});
