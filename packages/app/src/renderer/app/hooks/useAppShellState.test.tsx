import { afterEach, describe, expect, test } from "bun:test";
import * as React from "react";

import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import type { WorkspaceSidebarState } from "../../../../../shared/src/contracts/workspace/workspace-shell";
import { workspaceTabId } from "../../components/WorkspaceStrip";
import { SIDE_BAR_STORAGE_KEY, createAppServices, type AppServices } from "../wiring";
import { useAppShellState, type AppShellState } from "./useAppShellState";

const originalWindow = globalThis.window;
const workspaceId = "ws_alpha" as WorkspaceId;
const workspace = {
  id: workspaceId,
  displayName: "Alpha",
  absolutePath: "/tmp/alpha",
};

afterEach(() => {
  if (originalWindow) {
    globalThis.window = originalWindow;
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("useAppShellState", () => {
  test("derives the active workspace and tab id from sidebar state", () => {
    installRendererWindowStub();
    const services = createAppServices();
    services.workspace.setState({
      sidebarState: {
        openWorkspaces: [workspace],
        activeWorkspaceId: workspaceId,
      },
    });

    const state = renderState(services);

    expect(state.sidebarState.activeWorkspaceId).toBe(workspaceId);
    expect(state.activeWorkspace).toEqual(workspace);
    expect(state.activeWorkspaceTabId).toBe(workspaceTabId(workspaceId));
  });

  test("tracks activity bar route and collapse updates without selector-created objects", () => {
    installRendererWindowStub();
    const services = createAppServices();
    services.activityBar.getState().setActiveView("search");
    services.activityBar.getState().setSideBarCollapsed(true);

    const state = renderState(services);

    expect(state.activityBarViews).toBe(services.activityBar.getState().views);
    expect(state.activeActivityBarViewId).toBe("search");
    expect(state.sideBarCollapsed).toBe(true);
    expect(state.activeSideBarRoute).toEqual({ title: "Search", contentId: "search" });
  });

  test("tracks file tree, git badge, clipboard, and editor center state", () => {
    installRendererWindowStub();
    const services = createAppServices();
    const fileTree = {
      workspaceId,
      rootPath: "/tmp/alpha",
      nodes: [{ name: "index.ts", path: "index.ts", kind: "file" as const }],
      loading: false,
      errorMessage: null,
      readAt: "2026-04-30T00:00:00.000Z",
    };
    services.files.setState({
      fileTree,
      expandedPaths: { src: true },
      selectedPath: "index.ts",
      pendingExplorerEdit: {
        type: "rename",
        workspaceId,
        path: "index.ts",
        kind: "file",
      },
    });
    services.git.setState({ pathBadgeByPath: { "index.ts": "modified" } });
    services.fileClipboard.getState().copy([{ workspaceId, path: "index.ts", kind: "file" }]);
    services.editorWorkspace.getState().setCenterMode("editor-max");

    const state = renderState(services);

    expect(state.editorFileTree).toBe(fileTree);
    expect(state.editorExpandedPaths).toEqual({ src: true });
    expect(state.editorGitBadgeByPath).toEqual({ "index.ts": "modified" });
    expect(state.editorSelectedTreePath).toBe("index.ts");
    expect(state.editorPendingExplorerEdit?.type).toBe("rename");
    expect(state.fileClipboardCanPaste).toBe(true);
    expect(state.editorCenterMode).toBe("editor-max");
  });

  test("tracks harness, bottom panel, and terminal store slices", () => {
    installRendererWindowStub();
    const services = createAppServices();
    services.workspace.setState({
      sidebarState: {
        openWorkspaces: [workspace],
        activeWorkspaceId: workspaceId,
      },
    });
    const feedEntries = [{
      type: "harness/tool-call" as const,
      status: "started" as const,
      toolName: "Read",
      sessionId: "session_1",
      adapterName: "claude-code",
      workspaceId,
      timestamp: "2026-04-30T00:00:00.000Z",
      receivedSequence: 1,
    }];
    const sessionRef = {
      workspaceId,
      sessionId: "session_1",
      adapterName: "claude-code",
      timestamp: "2026-04-30T00:00:00.000Z",
      transcriptPath: "/tmp/transcript.jsonl",
      receivedSequence: 1,
    };
    services.harnessToolFeed.setState({ feedByWorkspaceId: { [workspaceId]: feedEntries } });
    services.harnessSession.setState({ sessionByWorkspaceId: { [workspaceId]: sessionRef } });
    services.harnessBadge.setState({
      badgeByWorkspaceId: {
        [workspaceId]: {
          workspaceId,
          state: "running",
          sessionId: "session_1",
          adapterName: "claude-code",
          timestamp: "2026-04-30T00:00:00.000Z",
        },
      },
    });
    services.bottomPanel.getState().setActiveView("problems");
    services.bottomPanel.getState().setHeight(404);
    services.bottomPanel.getState().detachTerminalFromBottom("terminal_1");
    services.terminal.getState().createTab({
      id: "terminal_1",
      workspaceId,
      createdAt: "2026-04-30T00:00:00.000Z",
    });

    const state = renderState(services);

    expect(state.badgeByWorkspaceId[workspaceId]?.state).toBe("running");
    expect(state.activeToolFeedEntries).toBe(feedEntries);
    expect(state.activeSessionRef).toBe(sessionRef);
    expect(state.activeBottomPanelViewId).toBe("problems");
    expect(state.bottomPanelHeight).toBe(404);
    expect(state.detachedBottomPanelTerminalIds).toEqual(["terminal_1"]);
    expect(state.terminalTabs.map((tab) => tab.id)).toEqual(["terminal_1"]);
  });
});

function renderState(services: AppServices): AppShellState {
  return createHookRunner(() => useAppShellState(services)).render();
}

function createHookRunner<T>(hook: () => T): { render(): T } {
  const internals = (React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
  }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const memoSlots: Array<{ value: unknown; deps?: readonly unknown[] | null } | undefined> = [];
  let hookIndex = 0;

  const dispatcher = {
    useCallback(callback: unknown, deps?: readonly unknown[] | null) {
      return dispatcher.useMemo(() => callback, deps);
    },
    useDebugValue() {},
    useMemo(factory: () => unknown, deps?: readonly unknown[] | null) {
      const index = hookIndex++;
      const previous = memoSlots[index];
      if (previous && areHookDepsEqual(previous.deps, deps)) {
        return previous.value;
      }
      const value = factory();
      memoSlots[index] = { value, deps };
      return value;
    },
    useSyncExternalStore(
      _subscribe: (listener: () => void) => () => void,
      getSnapshot: () => unknown,
    ) {
      hookIndex++;
      return getSnapshot();
    },
  };

  return {
    render() {
      hookIndex = 0;
      const previousDispatcher = internals.H;
      internals.H = dispatcher;
      try {
        return hook();
      } finally {
        internals.H = previousDispatcher;
      }
    },
  };
}

function areHookDepsEqual(
  previousDeps: readonly unknown[] | null | undefined,
  nextDeps: readonly unknown[] | null | undefined,
): boolean {
  if (!previousDeps || !nextDeps || previousDeps.length !== nextDeps.length) {
    return false;
  }

  return previousDeps.every((dependency, index) => Object.is(dependency, nextDeps[index]));
}

function installRendererWindowStub(): void {
  const sidebarState: WorkspaceSidebarState = {
    openWorkspaces: [],
    activeWorkspaceId: null,
  };
  const disposable = { dispose() {} };

  globalThis.window = {
    localStorage: {
      getItem(key: string) {
        return key === SIDE_BAR_STORAGE_KEY ? JSON.stringify({ size: 312 }) : null;
      },
      setItem() {},
    },
    nexusWorkspace: {
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
      async restoreSession() {
        return sidebarState;
      },
      onSidebarStateChanged() {
        return disposable;
      },
    },
    nexusHarness: {
      onObserverEvent() {
        return disposable;
      },
    },
    nexusEditor: {
      async invoke() {
        throw new Error("Editor bridge invoke was not expected in useAppShellState tests.");
      },
      onEvent() {
        return disposable;
      },
    },
    nexusSearch: {
      async startSearch() {
        throw new Error("Search bridge start was not expected in useAppShellState tests.");
      },
      async cancelSearch() {},
      onEvent() {
        return disposable;
      },
    },
    nexusGit: {
      async invoke() {
        throw new Error("Git bridge invoke was not expected in useAppShellState tests.");
      },
      onEvent() {
        return disposable;
      },
    },
    nexusFileActions: {
      async invoke() {
        throw new Error("File action invoke was not expected in useAppShellState tests.");
      },
      async startFileDrag() {
        return { type: "file-actions/start-file-drag/result", ok: true };
      },
      getPathForFile() {
        return "/tmp/file.txt";
      },
    },
  } as unknown as Window & typeof globalThis;
}
