import { expect, test } from "bun:test";
import {
  changedPeerGitParents,
  peerGitDecorations,
} from "../../../../../src/renderer/components/peer-workspace/git-tree";
import type { PeerGitStatus } from "../../../../../src/renderer/services/remote/peer-git-status";

const root = "D:\\Project";
const status = (files: PeerGitStatus["files"]): PeerGitStatus => ({
  branch: "main",
  ahead: 0,
  behind: 0,
  files,
});

test("peer Git colors and letters use drive path keys and the local decoration rules", () => {
  const changes = status([
    { path: "src/services/new.ts", oldPath: "old/old.ts", staged: "R", unstaged: "M" },
    { path: "removed/old.ts", staged: "D" },
    { path: "src/Conflict.ts", staged: "A", unstaged: "A" },
    { path: "src/draft.ts", unstaged: "?" },
    { path: "../outside.ts", unstaged: "M" },
  ]);
  const decorations = peerGitDecorations(root, changes);
  expect(decorations.files).toEqual(
    new Map([
      ["d:/project/src/services/new.ts", "modified"],
      ["d:/project/old/old.ts", "renamed"],
      ["d:/project/removed/old.ts", "deleted"],
      ["d:/project/src/conflict.ts", "conflict"],
      ["d:/project/src/draft.ts", "untracked"],
    ]),
  );
  expect(decorations.folders).toEqual(
    new Map([
      ["d:/project/src/services", "modified"],
      ["d:/project/src", "conflict"],
      ["d:/project/old", "renamed"],
    ]),
  );
});

test("only the immediate parents of paths added to or removed from the Git file set are invalidated", () => {
  const before = status([
    { path: "src/Unchanged.ts", staged: "M" },
    { path: "old/deep/removed.ts", staged: "D" },
  ]);
  const after = status([
    { path: "src/unchanged.ts", unstaged: "M" },
    { path: "src/new/add.ts", unstaged: "?" },
    { path: "README", unstaged: "M" },
    { path: "../outside.ts", unstaged: "M" },
  ]);
  expect(changedPeerGitParents(root, before, after)).toEqual(
    new Set(["d:/project/old/deep", "d:/project/src/new", "d:/project"]),
  );
});

test("a nested workspace decorates and refreshes only its own Git paths, including rename sources", () => {
  const topLevel = "/repo";
  const root = "/repo/packages/app";
  const before = { ...status([{ path: "packages/app/old/removed.ts", staged: "D" }]), topLevel };
  const after = {
    ...status([
      { path: "packages/app/src/new.ts", oldPath: "packages/app/lib/old.ts", staged: "R" },
      { path: "packages/app-extra/src/new.ts", staged: "A" },
      { path: "src/new.ts", staged: "A" },
      { path: "packages/shared/new.ts", oldPath: "packages/app/moved.ts", staged: "R" },
    ]),
    topLevel,
  };
  const { files, folders } = peerGitDecorations(root, after);
  expect(files).toEqual(
    new Map([
      [`${root}/src/new.ts`, "renamed"],
      [`${root}/lib/old.ts`, "renamed"],
      [`${root}/moved.ts`, "renamed"],
    ]),
  );
  expect(folders).toEqual(
    new Map([
      [`${root}/src`, "renamed"],
      [`${root}/lib`, "renamed"],
    ]),
  );
  expect(changedPeerGitParents(root, before, after)).toEqual(
    new Set([`${root}/old`, `${root}/src`, `${root}/lib`, root]),
  );
});
