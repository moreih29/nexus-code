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
  const groups = workspaceTrees(
    [
      {
        root: home,
        worktrees: [
          { workspace: home, isRoot: true, branch: undefined, sessions: [root] },
          { workspace: task, isRoot: false, branch: "test/branch", sessions: [child, grandchild] },
        ],
      },
    ],
    [family!],
    {},
    false,
  );
  const [inHome, inTask] = groups[0]?.worktrees ?? [];
  expect([...treeSessions(inHome?.roots ?? [])]).toEqual([root, child, grandchild]);
  expect(inTask?.roots).toEqual([]);
  expect(inTask?.moved).toEqual([{ key: root.key, title: root.title, count: 2 }]);
});

test("closed, remote and unparented tabs stay at the top", () => {
  const parent = session("parent");
  const oldLayout = session("legacy");
  const appFork = session("app-fork");
  const closed = session("closed", { parent: opener("missing", "Last title") });
  const brokenChain = session("broken-chain", { parent: opener("closed") });
  const peer = session("peer", {
    parent: { ...opener("parent", "Peer title"), device: { id: "d1", name: "Office" } },
  });
  const result = sessionTree([parent, oldLayout, appFork, closed, brokenChain, peer]);
  expect(result.map((node) => node.session)).toEqual([
    parent,
    oldLayout,
    appFork,
    closed,
    brokenChain,
    peer,
  ]);
  expect(result[3]).toMatchObject({ parentName: "Last title", parentClosed: true });
  expect(result[4]).not.toHaveProperty("parentClosed");
  expect(result[5]?.parentName).toBe("Peer title");
  expect(result[5]).not.toHaveProperty("parentClosed");
});

test("breaks cycles, skips ended terminals and stops walking after eight parent links", () => {
  const a = session("a", { parent: opener("b") });
  const b = session("b", { parent: opener("a") });
  const self = session("self", { parent: opener("self") });
  const ended = session("ended", { kind: "terminal", state: "exited" });
  const orphan = session("orphan", { parent: opener("ended") });
  expect(sessionTree([a, b, self, ended, orphan]).map(({ session }) => session)).toEqual([
    a,
    b,
    self,
    orphan,
  ]);
  const chain = Array.from({ length: 10 }, (_, i) =>
    session(`node${i}`, i ? { parent: opener(`node${i - 1}`) } : {}),
  );
  const [family, overflow] = sessionTree(chain);
  expect(family?.count).toBe(8);
  expect(overflow?.session.tabId).toBe("node9");
  expect(overflow?.depth).toBe(0);
  expect([...treeSessions([family!])]).toEqual(chain.slice(0, 9));
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
