import { expect, test } from "bun:test";
import { peerGitDisplayPath } from "../../../../../src/renderer/components/peer-workspace/git-path-label";
import { peerGitPaths } from "../../../../../src/renderer/services/remote/peer-git-paths";
import { peerPathRelativeTo } from "../../../../../src/renderer/utils/peer-path";

test.each([
  { path: "/repo/app/", root: "/repo/app", relative: "" },
  { path: "/repo/app/f", root: "/repo/app/", relative: "f" },
  { path: "/repo/apple/f", root: "/repo/app", relative: null },
  { path: "/repo/App/f", root: "/repo/app", relative: null },
  { path: "/repo/app/../f", root: "/repo/app", relative: null },
  { path: "d:/Repo/App/F.TxT", root: "D:\\repo\\app\\", relative: "F.TxT" },
  { path: "\\\\HOST\\SHARE\\app/f", root: "//host/share/app/", relative: "f" },
  { path: "//host/share-other/app/f", root: "\\\\host\\share", relative: null },
])("maps $path relative to $root", ({ path, root, relative }) => {
  expect(peerPathRelativeTo(path, root)).toBe(relative);
});

test("even a root of slash keeps working-file reads within the selected workspace", () => {
  const paths = peerGitPaths("/repo/app/", "/");
  expect(paths.toWorkspace("repo/app/f.ts")).toEqual({
    relative: "f.ts",
    absolute: "/repo/app/f.ts",
  });
  for (const path of ["repo/app", "repo/apple/f.ts", "outside/f.ts"]) {
    expect(paths.toWorkspace(path)).toEqual({ relative: null, absolute: null });
  }
  for (const path of ["repo/app/../f.ts", "/repo/app/f.ts"]) {
    expect(paths.toWorkspace(path)).toBeNull();
  }
  expect(paths.toGit("/", [])).toBeNull();
});

test("same-named changes inside and outside the workspace have distinct display scopes", () => {
  expect(peerGitDisplayPath("/repo/app", "app/doc/README.md", "/repo")).toEqual({
    path: "doc/README.md",
    fileName: "README.md",
    directory: "doc/",
    outsideWorkspace: false,
  });
  expect(peerGitDisplayPath("/repo/app", "doc/README.md", "/repo")).toEqual({
    path: "doc/README.md",
    fileName: "README.md",
    directory: "doc/",
    outsideWorkspace: true,
  });
});
