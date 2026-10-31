/**
 * Paths on the nexus command line: read from the caller's directory, kept
 * inside the workspace, and spelled as the workspace's host spells them.
 */
import { expect, test } from "bun:test";
import { type CliContext, describeLocation } from "../../../../src/main/features/cli/context";
import { splitLocation, workspaceFile } from "../../../../src/main/features/cli/paths";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";
import { APP, contextFor, fakeApp, SHELL_TAB } from "./fake-services";

function windowsApp(cwd: string): { ctx: CliContext; workspace: WorkspaceMeta } {
  const workspace = {
    id: APP,
    name: "app",
    rootPath: "C:\\w\\app",
    location: { kind: "local", rootPath: "C:\\w\\app" },
  } as WorkspaceMeta;
  const ctx = contextFor(fakeApp(), [], { workspaceId: APP, tabId: SHELL_TAB }, { cwd });
  return { ctx, workspace };
}

test("a Windows path is read from the caller's directory, case aside", () => {
  const { ctx, workspace } = windowsApp("c:\\W\\App\\src");
  expect(workspaceFile(ctx, workspace, "login.ts")).toEqual({
    relPath: "src/login.ts",
    filePath: "C:\\w\\app/src/login.ts",
  });
  expect(workspaceFile(ctx, workspace, "C:\\w\\app\\README.md").relPath).toBe("README.md");
});

test("a Windows path outside the workspace is refused", () => {
  const { ctx, workspace } = windowsApp("C:\\w\\app");
  expect(() => workspaceFile(ctx, workspace, "D:\\other.ts")).toThrow(
    "D:\\other.ts is not a file inside app (C:\\w\\app)",
  );
});

test("a POSIX root's paths are POSIX paths on any platform", () => {
  const ctx = contextFor(fakeApp(), [], undefined, { cwd: "/srv/app/src" });
  const workspace = {
    id: APP,
    name: "app",
    rootPath: "/srv/app",
    location: { kind: "ssh", host: "box", remotePath: "/srv/app" },
  } as WorkspaceMeta;
  expect(workspaceFile(ctx, workspace, "a.ts").relPath).toBe("src/a.ts");
});

test.each([
  ["src/a.ts", { file: "src/a.ts" }],
  ["src/a.ts:12", { file: "src/a.ts", line: 12 }],
  ["src/a.ts:12:5", { file: "src/a.ts", line: 12, column: 5 }],
  ["C:\\w\\a.ts:3", { file: "C:\\w\\a.ts", line: 3 }],
  ["C:\\w\\a.ts", { file: "C:\\w\\a.ts" }],
])("splitLocation(%j)", (input, expected) => {
  expect(splitLocation(input)).toEqual(expected);
});

test("line 0 is refused", () => {
  expect(() => splitLocation("a.ts:0")).toThrow("lines and columns count from 1: a.ts:0");
});

test("a workspace's place is spelled as its host spells it", () => {
  const at = (location: WorkspaceMeta["location"]) =>
    describeLocation({ location } as WorkspaceMeta);
  expect(at({ kind: "local", rootPath: "/w/app" })).toBe("/w/app");
  expect(at({ kind: "ssh", host: "box", user: "u", remotePath: "/srv/app" })).toBe(
    "u@box:/srv/app",
  );
  expect(at({ kind: "wsl", distro: "Ubuntu", remotePath: "/home/u/app" })).toBe(
    "wsl:Ubuntu:/home/u/app",
  );
});
