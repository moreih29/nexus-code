import { expect, test } from "bun:test";
import type { ListedSession } from "../../../../../src/renderer/services/chat/sessions";
import {
  conversationStatus,
  conversationTitle,
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
