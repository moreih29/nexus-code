import { expect, test } from "bun:test";
import type { AgentSession } from "../../../../../src/renderer/services/agent-sessions/model";
import {
  searchSessionTree,
  sessionChildren,
  sessionTree,
  treeSessions,
} from "../../../../../src/renderer/services/agent-sessions/session-tree";
import {
  moveSessionRoot,
  statusTrees,
  workspaceTrees,
} from "../../../../../src/renderer/services/agent-view/sidebar-tree";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

function session(tabId: string, fields: Partial<AgentSession> = {}): AgentSession {
  const workspaceId = fields.workspaceId ?? "ws";
  return {
    key: `${workspaceId}:${tabId}`,
    workspaceId,
    tabId,
    title: tabId,
    kind: "codex",
    agent: "codex",
    state: "idle",
    phase: "idle",
    estimated: false,
    since: undefined,
    message: undefined,
    prompt: undefined,
    ...fields,
  };
}

const opener = (tabId: string, name = "Saved name") => ({
  kind: "tab" as const,
  workspaceId: "old-workspace-id",
  tabId,
  name,
});

test("links by tab ID across workspaces and counts relocated descendants under their displayed root", () => {
  const root = session("root", { title: "Current name" });
  const child = session("child", { workspaceId: "task", parent: opener("root") });
  const grandchild = session("grandchild", { workspaceId: "task", parent: opener("child") });
  const [family] = sessionTree([root, child, grandchild]);
  expect(family?.children[0]?.parentName).toBe("Current name");
  expect(family?.count).toBe(2);
  const home = { id: "ws" } as WorkspaceMeta;
  const task = { id: "task" } as WorkspaceMeta;
  const families = [
    {
      root: home,
      worktrees: [
        { workspace: home, isRoot: true, branch: undefined, sessions: [root] },
        { workspace: task, isRoot: false, branch: "test/branch", sessions: [child, grandchild] },
      ],
    },
  ];
  const groups = workspaceTrees(families, [family!], {}, false);
  // The task holds only children, listed under their parent: it has no group.
  const [inHome, ...others] = groups[0]?.worktrees ?? [];
  expect([...treeSessions(inHome?.roots ?? [])]).toEqual([root, child, grandchild]);
  expect(inHome?.hosted).toBe(0);
  expect(others).toEqual([]);
  // Kept where empty worktrees are, it counts the children it holds.
  const [, inTask] = workspaceTrees(families, [family!], {}, false, () => true)[0]?.worktrees ?? [];
  expect(inTask?.roots).toEqual([]);
  expect(inTask?.hosted).toBe(2);
});

test("closed, remote and unparented tabs stay at the top", () => {
  const parent = session("parent");
  const oldLayout = session("legacy");
  const appFork = session("app-fork");
  const closed = session("closed", { parent: opener("missing", "Last title") });
  const peer = session("peer", {
    parent: { ...opener("parent", "Peer title"), device: { id: "d1", name: "Office" } },
  });
  const result = sessionTree([parent, oldLayout, appFork, closed, peer]);
  expect(result.map((node) => node.session)).toEqual([parent, oldLayout, appFork, closed, peer]);
  expect(result[3]).toMatchObject({ parentName: "Last title", parentClosed: true });
  expect(result[4]?.parentName).toBe("Peer title");
  expect(result[4]).not.toHaveProperty("parentClosed");
});

test("a grandchild stays with its parent when the grandparent closes", () => {
  const grandparent = session("grandparent", { title: "Last title" });
  const parent = session("parent", { parent: opener(grandparent.tabId, grandparent.title) });
  const child = session("child", { parent: opener(parent.tabId), phase: "attention" });
  expect(sessionTree([child, parent, grandparent]).map(({ session }) => session)).toEqual([
    grandparent,
  ]);
  const result = sessionTree([child, parent]);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    session: parent,
    parentName: "Last title",
    parentClosed: true,
    count: 1,
    group: "attention",
    children: [{ session: child, depth: 1, parentName: parent.title }],
  });
  expect(result[0]?.children[0]).not.toHaveProperty("parentClosed");
});

test("breaks cycles and treats a terminal that ended as missing", () => {
  const a = session("a", { parent: opener("b") });
  const b = session("b", { parent: opener("a") });
  const descendant = session("descendant", { parent: opener("a") });
  const self = session("self", { parent: opener("self") });
  const ended = session("ended", { kind: "terminal", state: "exited" });
  const orphan = session("orphan", { parent: opener("ended") });
  expect(
    sessionTree([a, b, descendant, self, ended, orphan]).map(({ session }) => session),
  ).toEqual([a, b, descendant, self, orphan]);
});

test.each([
  false,
  true,
])("the ninth listed parent link is cut with missing top opener = %s", (missingOpener) => {
  const root = session("node0", missingOpener ? { parent: opener("gone") } : {});
  const chain = [
    root,
    ...Array.from({ length: 9 }, (_, i) => session(`node${i + 1}`, { parent: opener(`node${i}`) })),
  ];
  const result = sessionTree(chain);
  expect(result.map(({ session, depth }) => [session.tabId, depth])).toEqual([
    ["node0", 0],
    ["node9", 0],
  ]);
  expect(result[0]?.count).toBe(8);
  expect([...treeSessions(result)]).toEqual(chain);
});

test("groups by the most urgent descendant, keeps tree search context and discloses idle rows in opening order", () => {
  const root = session("root", { phase: "running", since: 20 });
  const idle = session("idle", { parent: opener("root") });
  const done = session("done", { parent: opener("root"), phase: "done", since: 25 });
  const attention = session("attention", {
    parent: opener("done"),
    phase: "attention",
    since: 10,
    message: "Waiting for KEYWORD",
  });
  const idle2 = session("idle2", { parent: opener("root") });
  const [node] = sessionTree([root, idle, done, attention, idle2]);
  if (!node) throw new Error("missing root");
  expect(statusTrees([node]).attention).toEqual([node]);
  expect(node).toMatchObject({
    group: "attention",
    since: 10,
    count: 4,
    counts: { attention: 1, running: 0, done: 1, idle: 2 },
  });
  expect([...treeSessions(searchSessionTree([node], " keyword "))]).toEqual([
    root,
    done,
    attention,
  ]);
  const opts = { folded: false, groupIdle: true, showIdle: false };
  expect(sessionChildren(node, opts)).toEqual({ rows: [node.children[1]], idle: 2 });
  expect(sessionChildren(node, { ...opts, showIdle: true }).rows).toEqual(node.children);
  expect(sessionChildren(node, { ...opts, groupIdle: false }).rows).toEqual(node.children);
  expect(sessionChildren(node, { ...opts, folded: true })).toEqual({ rows: [], idle: 0 });
});

test("dragging reorders roots without changing child and hidden slots", () => {
  const keys = ["root", "child", "hidden", "another"];
  const roots = ["root", "another"];
  expect(moveSessionRoot(keys, roots, "root", "another", "after")).toEqual([
    "another",
    "child",
    "hidden",
    "root",
  ]);
  expect(moveSessionRoot(keys, roots, "child", "another", "after")).toBe(keys);
});
