import { expect, test } from "bun:test";
import type { ListedSession } from "../../../../../src/renderer/services/chat/sessions";
import {
  conversationStatus,
  conversationTitle,
  latestConversations,
  resolveConversation,
} from "../../../../../src/renderer/services/notes/conversation";
import type { Tab } from "../../../../../src/renderer/state/stores/tabs";
import type { NoteLink } from "../../../../../src/shared/notes/links";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

function workspace(id: string, rootPath: string, task?: WorkspaceMeta["task"]): WorkspaceMeta {
  return {
    id,
    name: id,
    location: { kind: "local", rootPath },
    rootPath,
    color: "auto",
    pinned: false,
    tabs: [],
    sortOrder: 0,
    pinnedSortOrder: 0,
    ...(task ? { task } : {}),
  };
}
const root = workspace("root", "/repo");
const task = workspace("task", "/worktrees/check", {
  parentId: root.id,
  branch: "check",
  worktreePath: "/worktrees/check",
});
const link: NoteLink = {
  agent: "claude",
  kind: "note",
  workspaceId: root.id,
  cwd: root.rootPath,
  tabId: "original",
  session: "current",
  sessions: ["earlier"],
  title: "Conversation",
  createdAt: 1,
  updatedAt: 1,
};
const stores = { noteWorkspaceId: root.id, workspaces: [root, task], tabsByWorkspace: {} };

function claude(id: string, sessionId: string, cwd = root.rootPath): Tab {
  return {
    id,
    type: "claude",
    title: id,
    defaultTitle: id,
    isPinned: false,
    isPreview: false,
    props: { cwd, sessionId },
  };
}
const history: ListedSession[] = [
  { sessionId: "earlier", title: "Earlier", lastModified: 1, profileId: "old" },
  { sessionId: "current", title: "Current", lastModified: 2, profileId: "default" },
];

test("prefers the original tab before consulting its current session or history", () => {
  const tab = claude("original", "after-clear");
  expect(
    resolveConversation(link, {
      ...stores,
      history,
      tabsByWorkspace: {
        [root.id]: { original: tab, other: claude("other", "current") },
      },
    }),
  ).toEqual({ kind: "open", workspace: root, tab });
});

test("finds the current session before an earlier one in the same location family", () => {
  const current = claude("reopened", "current", task.rootPath);
  const unrelated = workspace("other", "/different");
  expect(
    resolveConversation(link, {
      ...stores,
      workspaces: [root, task, unrelated],
      tabsByWorkspace: {
        [root.id]: { earlier: claude("earlier", "earlier") },
        [unrelated.id]: { outside: claude("outside", "current") },
        [task.id]: { reopened: current },
      },
    }),
  ).toEqual({ kind: "moved", workspace: task, tab: current });
});

test("finds a Codex thread under an earlier ID when the workspace ID changes", () => {
  const replaced = workspace("replaced", root.rootPath);
  const tab: Tab = {
    id: "new",
    type: "codex",
    title: "New",
    defaultTitle: "Codex",
    isPinned: false,
    isPreview: false,
    props: { cwd: root.rootPath, threadId: "earlier" },
  };
  expect(
    resolveConversation(
      { ...link, agent: "codex" },
      {
        noteWorkspaceId: replaced.id,
        workspaces: [replaced],
        tabsByWorkspace: { [replaced.id]: { new: tab } },
      },
    ),
  ).toEqual({ kind: "moved", workspace: replaced, tab });
});

test("resumes a closed conversation in the worktree and the profile that has it", () => {
  const taskLink = { ...link, workspaceId: task.id, cwd: task.rootPath };
  expect(resolveConversation(taskLink, { ...stores, history })).toEqual({
    kind: "resume",
    workspace: task,
    session: history[1],
  });
  expect(resolveConversation(taskLink, { ...stores, history: [history[0]] })).toEqual({
    kind: "resume",
    workspace: task,
    session: history[0],
  });
});

test("keeps the saved title for a closed conversation and falls back to history when it is empty", () => {
  const promptTitle = "Read this note and start the task. Open it with nexus note read n1234567.";
  const closed = resolveConversation(link, {
    ...stores,
    history: [{ ...history[1], title: promptTitle }],
  });
  expect(closed.kind).toBe("resume");
  expect(conversationTitle(link.title, closed)).toBe(link.title);
  expect(conversationTitle("", closed)).toBe(promptTitle);
  const tab = claude("original", "current");
  const open = resolveConversation(link, {
    ...stores,
    tabsByWorkspace: { [root.id]: { original: tab } },
  });
  expect(conversationTitle(link.title, open)).toBe(tab.title);
});

test("returns missing for a deleted session or a removed worktree", () => {
  expect(resolveConversation(link, stores)).toEqual({ kind: "missing" });
  const taskLink = { ...link, workspaceId: task.id, cwd: task.rootPath };
  expect(
    resolveConversation(taskLink, {
      ...stores,
      workspaces: [root],
      history,
      tabsByWorkspace: { [task.id]: { original: claude("original", "current", task.rootPath) } },
    }),
  ).toEqual({ kind: "missing" });
});

test.each([
  ["running", false, "running"],
  ["busy", false, "running"],
  ["permissionPending", false, "attention"],
  ["needsInput", false, "attention"],
  ["error", true, "failed"],
  ["completed", true, "completed"],
  ["idle", true, "seen"],
  ["idle", false, "idle"],
] as const)("maps %s with turns=%s to %s", (state, hasTurns, expected) => {
  const target = resolveConversation(link, {
    ...stores,
    tabsByWorkspace: {
      [root.id]: { original: claude("original", "current") },
    },
  });
  expect(conversationStatus(target, { state, hasTurns }, undefined)).toBe(expected);
});

test("shows a limit wait in an open tab and a saved result after closing", () => {
  const open = resolveConversation(link, {
    ...stores,
    tabsByWorkspace: {
      [root.id]: { original: claude("original", "current") },
    },
  });
  expect(conversationStatus(open, { state: "idle", limitWait: { at: 10 } }, undefined)).toBe(
    "limitWait",
  );
  const closed = resolveConversation(link, { ...stores, history });
  expect(conversationStatus(closed, undefined, undefined)).toBe("closed");
  expect(conversationStatus(closed, undefined, { state: "done", at: 0 })).toBe("reported");
  const missing = resolveConversation(link, stores);
  expect(conversationStatus(missing, undefined, { state: "failed", at: 0 })).toBe("failed");
  expect(conversationStatus(missing, undefined, undefined)).toBe("missing");
});

test("links to an old tab and its reopened tab use the newest link for one live conversation", () => {
  const reopened = claude("reopened", "current", task.rootPath);
  const separate = claude("separate", "current", task.rootPath);
  const live = {
    ...stores,
    tabsByWorkspace: { [task.id]: { reopened, separate } },
  };
  const entries = [
    { id: "l1234567", link: { ...link, kind: "task" as const } },
    {
      id: "l1234568",
      link: {
        ...link,
        kind: "card" as const,
        tabId: reopened.id,
        workspaceId: task.id,
        updatedAt: 10,
      },
    },
    {
      id: "l1234569",
      link: { ...link, tabId: separate.id, workspaceId: task.id },
    },
  ];
  const rows = entries.map((entry) => ({ entry, target: resolveConversation(entry.link, live) }));
  const conversations = latestConversations(rows);
  expect(conversations.map(({ entry }) => entry.id)).toEqual(["l1234568", "l1234569"]);
  expect(conversations[0].target).toEqual({ kind: "open", workspace: task, tab: reopened });
});

test("closed conversations prefer a resumable link and the latest actual report", () => {
  const taskEntry = {
    id: "l1234567",
    link: { ...link, kind: "task" as const, result: { state: "failed" as const, at: 3 } },
  };
  const cardEntry = {
    id: "l1234568",
    link: { ...link, kind: "card" as const, session: undefined, sessions: [], updatedAt: 10 },
  };
  const reportEntry = {
    id: "l1234569",
    link: {
      ...link,
      tabId: "older-tab",
      kind: "line" as const,
      result: { state: "done" as const, at: 7 },
    },
  };
  const rows = [taskEntry, cardEntry, reportEntry].map((entry) => ({
    entry,
    target: resolveConversation(entry.link, { ...stores, history }),
  }));
  const [merged, duplicate] = latestConversations(rows);
  expect(duplicate).toBeUndefined();
  expect(merged.target.kind).toBe("resume");
  expect(merged.result).toEqual({ state: "done", at: 7 });
  expect(conversationStatus(merged.target, undefined, merged.result)).toBe("reported");
  expect(rows[0].entry.link.result).toEqual({ state: "failed", at: 3 });
  expect(rows[1].entry.link.result).toBeUndefined();
});

test("an idle restored chat counts stored turns as seen and leaves a truly empty tab idle", () => {
  const target = resolveConversation(link, {
    ...stores,
    tabsByWorkspace: { [root.id]: { original: claude("original", "current") } },
  });
  const idle = { state: "idle", hasTurns: false };
  expect(conversationStatus(target, idle, undefined, { hasStoredTurns: true })).toBe("seen");
  expect(conversationStatus(target, undefined, undefined, { hasStoredTurns: true })).toBe("seen");
  expect(conversationStatus(target, idle, undefined, { checking: true })).toBe("checking");
  expect(conversationStatus(target, idle, undefined)).toBe("idle");
});

test.each([
  ["idle", "reported", "failed"],
  ["completed", "reported", "failed"],
  ["error", "reported", "failed"],
  ["running", "running", "running"],
  ["busy", "running", "running"],
  ["permissionPending", "attention", "attention"],
  ["needsInput", "attention", "attention"],
] as const)("a %s task chip prefers its report unless the conversation is active", (state, done, failed) => {
  const target = resolveConversation(link, {
    ...stores,
    tabsByWorkspace: { [root.id]: { original: claude("original", "current") } },
  });
  expect(conversationStatus(target, { state }, { state: "done", at: 10 }, { line: true })).toBe(
    done,
  );
  expect(conversationStatus(target, { state }, { state: "failed", at: 10 }, { line: true })).toBe(
    failed,
  );
});
