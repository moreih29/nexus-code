import { afterEach, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { buildGitFileContextMenuItems } from "../../../../../src/renderer/components/files/git/file-row/file-context-menu";
import type { GitGroupActions } from "../../../../../src/renderer/components/files/git/file-row/group";
import { gitFileMenuActions } from "../../../../../src/renderer/components/files/git/file-row/row";
import {
  allPeerGitTrees,
  PeerGitPanel,
  peerGitEntries,
} from "../../../../../src/renderer/components/peer-workspace/git-panel";
import * as workspaceStore from "../../../../../src/renderer/state/stores/peer-workspace";

const { peerTargetId, usePeerWorkspaceStore } = workspaceStore;
const target: workspaceStore.PeerWorkspaceTarget = {
  accountKey: "account",
  deviceId: "peer",
  deviceName: "Desktop",
  platform: "linux",
  workspaceId: "repo",
  workspace: { id: "repo", name: "Repo", path: "/repo" },
};
const previous = usePeerWorkspaceStore.getState();

afterEach(() => usePeerWorkspaceStore.setState(previous, true));

function render(): string {
  const storeView = spyOn(workspaceStore, "usePeerWorkspaceStore");
  storeView.mockImplementation(
    Object.assign(
      <T,>(select: (state: typeof previous) => T) => select(usePeerWorkspaceStore.getState()),
      usePeerWorkspaceStore,
    ),
  );
  try {
    return renderToStaticMarkup(
      <PeerGitPanel target={target} canRead updateNeeded={false} refresh={() => {}} rejoin={0} />,
    );
  } finally {
    storeView.mockRestore();
  }
}

test("Source Control is headed by the local title row, then the changes and history toggle", () => {
  const html = render();
  expect(html).toContain("Source Control");
  const refresh = html.indexOf('aria-label="Refresh source control"');
  expect(html.indexOf("Source Control")).toBeLessThan(refresh);
  expect(refresh).toBeLessThan(html.indexOf("History"));
  expect(html).toContain('title="No staging or commits"');
  expect(html).toContain('role="img" aria-label="Read-only"');
  expect(html).not.toContain("Read-only</span>");
});

test("the changes fall in the local panel's four groups, in its order", () => {
  const store = usePeerWorkspaceStore.getState();
  store.select(target, null);
  store.setGitResult(peerTargetId(target), {
    ok: true,
    value: {
      branch: "main",
      ahead: 0,
      behind: 0,
      files: [
        { path: "new.ts", unstaged: "?" },
        { path: "both.ts", staged: "M", unstaged: "M" },
        { path: "conflict.ts", staged: "U", unstaged: "U" },
      ],
    },
  });
  const html = render();
  const order = ["Merge Changes", "Staged Changes", "Changes", "Untracked"].map((label) =>
    html.indexOf(`<section aria-label="${label}"`),
  );
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(html).not.toContain("Stage All");
  expect(html).not.toContain("lucide-ellipsis");
});

const files = [
  { path: "src/app/main.ts", staged: "M", unstaged: "M" },
  { path: "src/new.ts", unstaged: "?" },
  { path: "README.md", staged: "R", oldPath: "README.txt" },
];

function withChanges(): void {
  const store = usePeerWorkspaceStore.getState();
  store.select(target, null);
  store.setGitResult(peerTargetId(target), {
    ok: true,
    value: { branch: "main", ahead: 0, behind: 0, files },
  });
}

test("the changes are the local panel's entries: Git's path, its old path and both letters", () => {
  const { entries, files: byPath } = peerGitEntries(files);
  expect(entries.staged).toEqual([
    { relPath: "src/app/main.ts", xy: "MM", conflictType: null },
    { relPath: "README.md", oldRelPath: "README.txt", xy: "R.", conflictType: null },
  ]);
  expect(entries.working.map((entry) => entry.xy)).toEqual(["MM"]);
  expect(entries.untracked).toEqual([{ relPath: "src/new.ts", xy: ".?", conflictType: null }]);
  expect(byPath.get("src/new.ts")).toBe(files[1]);
  expect(allPeerGitTrees(entries)).toEqual({
    merge: [],
    staged: ["src", "src/app"],
    working: ["src", "src/app"],
    untracked: ["src"],
  });
});

test("as a tree by default, as locally, with the view toggle and expand all, and no row writes", () => {
  withChanges();
  const html = render();
  expect(html).toContain('role="tree"');
  expect(html).toContain('aria-label="Expand all folders"');
  expect(html).toContain('aria-label="View as List"');
  expect(html).not.toContain("Stage changes");
  expect(html).not.toContain("Discard changes");
  expect(html).not.toContain("Stage folder");
});

test("as a list once switched, each change a local row that opens its diff", () => {
  withChanges();
  usePeerWorkspaceStore.getState().setGitViewMode(peerTargetId(target), "list");
  const html = render();
  expect(html).not.toContain('role="tree"');
  expect(html).not.toContain('aria-label="Expand all folders"');
  expect(html).toContain('aria-label="Open diff for src/app/main.ts"');
  expect(html).toContain('aria-label="Open diff for README.txt → README.md"');
  expect(html).not.toContain("Stage changes");
  expect(html).not.toContain("Discard changes");
});

test("a change's menu has only what looks: open it, its changes, and its paths", () => {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (..._args: unknown[]) => {
      calls.push(name);
    };
  const actions = {
    readOnly: true,
    stage: record("stage"),
    unstage: record("unstage"),
    discard: record("discard"),
    markResolved: record("markResolved"),
    openDiff: record("openDiff"),
    openFile: record("openFile"),
    revealInOS: record("revealInOS"),
    copyPath: record("copyPath"),
    copyRelativePath: record("copyRelativePath"),
    addToGitignore: record("addToGitignore"),
    openMenu: record("openMenu"),
    toggleGroup: record("toggleGroup"),
    toggleTreeNode: record("toggleTreeNode"),
    addPathsToGitignore: record("addPathsToGitignore"),
    stashGroup: record("stashGroup"),
  } satisfies GitGroupActions;
  const entry = { relPath: "a.ts", xy: ".M", conflictType: null };
  const labels = (groupKey: "working" | "staged" | "untracked" | "merge") =>
    buildGitFileContextMenuItems(groupKey, gitFileMenuActions(entry, groupKey, actions)).map(
      (item) => (item.kind === "item" ? item.label : "-"),
    );
  expect(labels("working")).toEqual([
    "Open File",
    "Open Changes",
    "-",
    "Copy Path",
    "Copy Relative Path",
  ]);
  expect(labels("staged")).toEqual(labels("working"));
  expect(labels("untracked")).toEqual(["Open File", "-", "Copy Path", "Copy Relative Path"]);
  expect(labels("merge")).toEqual(["Open Diff"]);
  for (const item of buildGitFileContextMenuItems(
    "working",
    gitFileMenuActions(entry, "working", actions),
  )) {
    if (item.kind === "item") item.onSelect();
  }
  expect(calls).toEqual(["openFile", "openDiff", "copyPath", "copyRelativePath"]);
});

test("a group of changes folds by a heading that leads with its chevron, no platform triangle", () => {
  const store = usePeerWorkspaceStore.getState();
  store.select(target, null);
  store.setGitResult(peerTargetId(target), {
    ok: true,
    value: { branch: "main", ahead: 0, behind: 0, files: [{ path: "a.txt", staged: "M" }] },
  });
  const html = render();
  expect(html).not.toContain("<summary");
  const heading = html.match(
    /<section aria-label="Staged Changes">.*?aria-expanded="true">(.*?)<\/button>/,
  );
  expect(heading?.[1]).toMatch(/^<svg[^>]*lucide-chevron-right/);
});
