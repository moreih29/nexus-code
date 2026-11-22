import { expect, test } from "bun:test";
import {
  loadPeerFolder,
  peerTreeRows,
} from "../../../../../src/renderer/components/peer-workspace/tree-model";
import { peerPathKey, peerRelativePath } from "../../../../../src/renderer/utils/peer-path";
import { ipcErr, ipcOk } from "../../../../../src/shared/ipc/result";

test("truncated directories and symlinks remain visible without expanding links", async () => {
  const folder = {
    path: "C:\\",
    entries: [
      { name: "Source", kind: "dir" },
      { name: "Link", kind: "link" },
    ] as const,
    truncated: true,
  };
  expect(await loadPeerFolder(async () => ipcOk(folder))).toEqual({ folder });
  const root = "c:/";
  const rows = peerTreeRows({
    root,
    title: "Demo",
    expanded: new Set(["c:/source", "c:/link"]),
    collapsedRoot: false,
    errors: {},
    folders: {
      [peerPathKey(root)]: folder,
      "c:/source": { path: "C:/Source", entries: [{ name: "Hello.ts", kind: "file" }] },
      "c:/link": { path: "C:/Link", entries: [{ name: "Invisible", kind: "file" }] },
    },
  });
  expect(rows.map((row) => (row.kind === "entry" ? [row.path, row.node.type] : row.kind))).toEqual([
    ["C:\\", "dir"],
    ["C:\\Source", "dir"],
    ["C:\\Source\\Hello.ts", "file"],
    ["C:\\Link", "symlink"],
    "truncated",
  ]);
  expect(peerPathKey("c:\\SOURCE/HELLO.ts")).toBe("c:/source/hello.ts");
  expect(peerRelativePath("C:\\SOURCE/Hello.ts", "c:/source")).toBe("Hello.ts");
  expect(peerRelativePath("c:/", "C:\\")).toBe(".");
  expect(peerRelativePath("/POSIX/Foo", "/posix")).toBe("/POSIX/Foo");
});

test("file listing reports missing workspaces, missing folders, older hosts and connection errors", async () => {
  for (const [kind, message, error] of [
    ["not-found", "no such workspace", "missingWorkspace"],
    ["not-found", "/w/sub does not exist", "missingFolder"],
    ["unsupported", "files.list", "updateNeeded"],
    ["permission-denied", "forbidden", "accessDenied"],
    ["unavailable", "offline", "connectionUnavailable"],
  ]) {
    expect(await loadPeerFolder(async () => ipcErr(kind, message))).toEqual({ error });
  }
  expect(
    await loadPeerFolder(async () => {
      throw new Error("Connection lost");
    }),
  ).toEqual({ error: "connectionUnavailable" });
  const rows = peerTreeRows({
    root: "/w",
    title: "Demo",
    folders: {},
    expanded: new Set(),
    collapsedRoot: false,
    errors: { "/w": "missingFolder" },
  });
  expect(rows[1]).toMatchObject({ kind: "error", folder: "/w" });
});
