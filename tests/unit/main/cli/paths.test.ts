/**
 * Paths on the nexus command line: read from the caller's directory, kept
 * inside the workspace, and spelled as the workspace's host spells them.
 */
import { describe, expect, test } from "bun:test";
import type { CliContext } from "../../../../src/main/features/cli/context";
import {
  absolutePath,
  callerPath,
  splitLocation,
  workspaceFile,
} from "../../../../src/main/features/cli/paths";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";
import { APP, contextFor, fakeApp, SHELL_TAB } from "./fake-services";

function windowsApp(
  cwd: string,
  invocation: { tempDir?: string; msysRoot?: string } = {},
): { ctx: CliContext; workspace: WorkspaceMeta } {
  const workspace = {
    id: APP,
    name: "app",
    rootPath: "C:\\w\\app",
    location: { kind: "local", rootPath: "C:\\w\\app" },
  } as WorkspaceMeta;
  const ctx = contextFor(
    fakeApp(),
    [],
    { workspaceId: APP, tabId: SHELL_TAB },
    { cwd, ...invocation },
  );
  return { ctx, workspace };
}

test("a Windows path is read from the caller's directory, case aside", () => {
  const { ctx, workspace } = windowsApp("c:\\W\\App\\src");
  // The editor names the file as the renderer does, from a root spelled C:/w/app.
  expect(workspaceFile(ctx, workspace, "login.ts")).toEqual({
    relPath: "src/login.ts",
    filePath: "C:/w/app/src/login.ts",
  });
  expect(workspaceFile(ctx, workspace, "C:\\w\\app\\README.md").relPath).toBe("README.md");
});

test("a Windows path outside the workspace is refused", () => {
  const { ctx, workspace } = windowsApp("C:\\w\\app");
  expect(() => workspaceFile(ctx, workspace, "D:\\other.ts")).toThrow(
    "D:\\other.ts is not a file inside app (C:\\w\\app)",
  );
});

describe("a path from Git Bash", () => {
  const gitBash = { tempDir: "C:\\Users\\me\\AppData\\Local\\Temp", msysRoot: "C:\\Git\\" };

  test.each([
    ["/c/w/app/src/a.ts", "C:\\w\\app\\src\\a.ts"],
    ["/C", "C:\\"],
    ["/tmp/shot.png", "C:\\Users\\me\\AppData\\Local\\Temp\\shot.png"],
    ["/tmp", "C:\\Users\\me\\AppData\\Local\\Temp"],
    ["/usr/share/x", "C:\\Git\\usr\\share\\x"],
    ["//box/share/a.png", "\\\\box\\share\\a.png"],
    ["shots/a.png", "C:\\w\\app\\shots\\a.png"],
    ["D:/out/a.png", "D:\\out\\a.png"],
  ])("%s is read as Windows spells it", (input, expected) => {
    const { ctx } = windowsApp("C:\\w\\app", gitBash);
    expect(callerPath(ctx, input)).toBe(expected);
  });

  test("names a workspace's file", () => {
    const { ctx, workspace } = windowsApp("C:\\w\\app", gitBash);
    expect(workspaceFile(ctx, workspace, "/c/w/app/src/a.ts")).toEqual({
      relPath: "src/a.ts",
      filePath: "C:/w/app/src/a.ts",
    });
    expect(absolutePath(ctx, workspace, "/c/w/app/tools")).toBe("C:\\w\\app\\tools");
  });

  test("keeps its drives when the launcher could not tell where / is", () => {
    const { ctx } = windowsApp("C:\\w\\app", { ...gitBash, msysRoot: "" });
    expect(callerPath(ctx, "/d/out.png")).toBe("D:\\out.png");
    expect(callerPath(ctx, "/usr/x")).toBe("C:\\usr\\x");
  });

  test("is not read so from another Windows shell", () => {
    const { ctx } = windowsApp("C:\\w\\app");
    expect(callerPath(ctx, "/c/out.png")).toBe("C:\\c\\out.png");
  });

  test("on a POSIX host stays as it is", () => {
    const ctx = contextFor(fakeApp(), [], undefined, { cwd: "/srv/app", ...gitBash });
    expect(callerPath(ctx, "/c/out.png")).toBe("/c/out.png");
  });
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
