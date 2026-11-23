import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PeerFileTree,
  peerTreeMenu,
} from "../../../../../src/renderer/components/peer-workspace/file-tree";
import {
  type PeerWorkspaceTarget,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../../../../src/renderer/state/stores/peer-workspace";

const target: PeerWorkspaceTarget = {
  accountKey: "account",
  deviceId: "desktop",
  deviceName: "Desktop",
  platform: "linux",
  workspaceId: "repo",
  workspace: { id: "repo", name: "Repo", path: "/home/me/repo" },
};
const previous = usePeerWorkspaceStore.getState();

afterEach(() => usePeerWorkspaceStore.setState(previous, true));

test("the tree is headed by the local root header, with nothing that writes", () => {
  const html = renderToStaticMarkup(
    <PeerFileTree target={target} canRead={false} rejoin={0} sessionHint={0} />,
  );
  expect(html).toContain("<header");
  expect(html).toContain(">repo</span>");
  expect(html).toContain('aria-label="Refresh Explorer"');
  expect(html).toContain('aria-label="Collapse Folders"');
  expect(html).not.toContain("New File");
  expect(html).not.toContain("New Folder");
  expect(html).not.toContain('role="treeitem"');
});

test("a row's menu opens a file and copies paths, with the local shortcuts", () => {
  const open = () => {};
  const file = peerTreeMenu({ path: "/home/me/repo/a.ts", file: true }, "/home/me/repo", open);
  expect(file.map((item) => (item.kind === "item" ? item.label : "-"))).toEqual([
    "Open",
    "-",
    "Copy Path",
    "Copy Relative Path",
  ]);
  expect(file.every((item) => item.kind !== "item" || item.label === "Open" || item.shortcut)).toBe(
    true,
  );
  const folder = peerTreeMenu({ path: "/home/me/repo/src", file: false }, "/home/me/repo", open);
  expect(folder.map((item) => (item.kind === "item" ? item.label : "-"))).toEqual([
    "Copy Path",
    "Copy Relative Path",
  ]);
});

test("collapsing the folders keeps the root open", () => {
  const store = usePeerWorkspaceStore.getState();
  const id = peerTargetId(target);
  store.select(target, null);
  store.toggleFolder(id, "/home/me/repo/src");
  store.toggleFolder(id, "/home/me/repo/src/lib");
  store.collapseFolders(id);
  expect(usePeerWorkspaceStore.getState().views[id]?.expanded.size).toBe(0);
});
