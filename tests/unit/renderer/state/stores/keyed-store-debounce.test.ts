import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { useGitStore } from "../../../../../src/renderer/state/stores/git";
import {
  cancelStatusHintRefresh,
  scheduleStatusHintRefresh,
} from "../../../../../src/renderer/state/stores/git/draft-persistence";
import { createDefaultSession } from "../../../../../src/renderer/state/stores/git/session-defaults";
import { usePanelViewOptionsStore } from "../../../../../src/renderer/state/stores/panel-view-options";
import {
  cancelViewOptionsSave,
  scheduleViewOptionsSave,
} from "../../../../../src/renderer/state/stores/panel-view-options/io";
import { DEFAULT_REPO_CAPABILITIES } from "../../../../../src/shared/git/types";

const calls: unknown[][] = [];
const originalWindow = globalThis.window;

beforeEach(() => {
  calls.length = 0;
  jest.useFakeTimers();
  Object.assign(globalThis, {
    window: {
      ipc: {
        call: async (...args: unknown[]) => {
          calls.push(args);
          return {
            branch: null,
            merge: [],
            staged: [],
            working: [],
            untracked: [],
            capabilities: DEFAULT_REPO_CAPABILITIES,
          };
        },
      },
    },
  });
});

afterEach(() => {
  jest.useRealTimers();
  Object.assign(globalThis, { window: originalWindow });
});

test("panel options debounce per workspace and panel and cancel only the closing workspace", () => {
  const first = crypto.randomUUID();
  const closed = crypto.randomUUID();

  scheduleViewOptionsSave("git", first, "tree");
  scheduleViewOptionsSave("search", first, "tree");
  scheduleViewOptionsSave("git", closed, "list");
  jest.advanceTimersByTime(100);
  scheduleViewOptionsSave("git", first, "list");
  cancelViewOptionsSave(closed);

  jest.advanceTimersByTime(149);
  expect(calls).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(calls).toEqual([
    ["panel", "setViewOptions", { workspaceId: first, panelKind: "search", viewMode: "tree" }],
  ]);
  jest.advanceTimersByTime(100);
  expect(calls).toEqual([
    ["panel", "setViewOptions", { workspaceId: first, panelKind: "search", viewMode: "tree" }],
    ["panel", "setViewOptions", { workspaceId: first, panelKind: "git", viewMode: "list" }],
  ]);
});

test("Git passive refresh delays the last hint and drops a cancelled workspace's hint", async () => {
  const first = crypto.randomUUID();
  const closed = crypto.randomUUID();
  const oldSessions = useGitStore.getState().sessions;
  const sessions = new Map(oldSessions);
  for (const id of [first, closed]) {
    sessions.set(
      id,
      createDefaultSession({ repoInfo: { kind: "repo", topLevel: "/repo", gitDir: "/repo/.git" } }),
    );
  }
  useGitStore.setState({ sessions });
  try {
    scheduleStatusHintRefresh(first);
    scheduleStatusHintRefresh(closed);
    jest.advanceTimersByTime(100);
    scheduleStatusHintRefresh(first);
    cancelStatusHintRefresh(closed);
    jest.advanceTimersByTime(149);
    expect(calls).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(calls).toEqual([["git", "getStatus", { workspaceId: first }]]);
    await Promise.resolve();
    await Promise.resolve();
    expect(useGitStore.getState().sessions.get(first)?.inFlightOp).toBeNull();
  } finally {
    useGitStore.setState({ sessions: oldSessions });
  }
});

const workspaceId = "workspace-with-view-options";
const entryKey = `git:${workspaceId}`;

/** Clears the entries and any pending persistence after a panel-options case. */
function resetPanelViewOptions() {
  usePanelViewOptionsStore.getState().closeForWorkspace(workspaceId);
  usePanelViewOptionsStore.setState({ entries: new Map() });
}

/** Holds the saved view mode until the test delivers the IPC response. */
function holdViewOptionsRead() {
  const read = Promise.withResolvers<{ viewMode: "tree" }>();
  Object.assign(globalThis, {
    window: {
      ipc: { call: () => read.promise },
    },
  });
  return async () => {
    read.resolve({ viewMode: "tree" });
    await read.promise;
    // Drain the IPC envelope and store continuation.
    await Promise.resolve();
    await Promise.resolve();
  };
}

test("a slow view options read preserves the user's newer view mode", async () => {
  try {
    const finishRead = holdViewOptionsRead();
    const store = usePanelViewOptionsStore.getState();
    store.loadViewOptions("git", workspaceId);
    store.setViewMode("git", workspaceId, "list");

    await finishRead();

    expect(usePanelViewOptionsStore.getState().entries.get(entryKey)?.viewMode).toBe("list");
  } finally {
    resetPanelViewOptions();
  }
});

test("closing a workspace drops its view options and ignores its pending read", async () => {
  try {
    const finishRead = holdViewOptionsRead();
    const store = usePanelViewOptionsStore.getState();
    store.loadViewOptions("git", workspaceId);
    const otherWorkspace = "another-workspace";
    store.loadViewOptions("git", otherWorkspace);
    store.closeForWorkspace(workspaceId);

    await finishRead();

    const entries = usePanelViewOptionsStore.getState().entries;
    expect(entries.has(entryKey)).toBe(false);
    expect(entries.get(`git:${otherWorkspace}`)?.viewMode).toBe("tree");
  } finally {
    resetPanelViewOptions();
  }
});
