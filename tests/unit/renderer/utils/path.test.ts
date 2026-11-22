import { describe, expect, it } from "bun:test";
import {
  isWithinWorkspace,
  shownPath,
  workspacePathParts,
} from "../../../../src/renderer/utils/path";

describe("isWithinWorkspace", () => {
  it("1. file inside workspace → true", () => {
    expect(isWithinWorkspace("/workspace/foo/bar", "/workspace")).toBe(true);
  });

  it("2. file outside workspace → false", () => {
    expect(isWithinWorkspace("/other/path", "/workspace")).toBe(false);
  });

  it("3. absPath equals workspaceRoot exactly → true", () => {
    expect(isWithinWorkspace("/workspace", "/workspace")).toBe(true);
  });

  it("4. prefix trap: /workspace2/file vs /workspace → false", () => {
    expect(isWithinWorkspace("/workspace2/file", "/workspace")).toBe(false);
  });

  it("5a. absPath with trailing slash → true", () => {
    expect(isWithinWorkspace("/workspace/", "/workspace")).toBe(true);
  });

  it("5b. workspaceRoot with trailing slash → true", () => {
    expect(isWithinWorkspace("/workspace/foo", "/workspace/")).toBe(true);
  });

  it("6. absPath with .. traversal outside workspace → false", () => {
    expect(isWithinWorkspace("/workspace/../other/file", "/workspace")).toBe(false);
  });

  it("7. empty workspaceRoot → false", () => {
    expect(isWithinWorkspace("/workspace/foo", "")).toBe(false);
  });

  it("8. empty absPath → false", () => {
    expect(isWithinWorkspace("", "/workspace")).toBe(false);
  });
});

describe("shownPath", () => {
  it("names a file from its folder by either separator, as a rewind's list shows it", () => {
    expect(shownPath("C:\\work\\demo\\notes\\r1.md", "C:\\work\\demo")).toBe("notes/r1.md");
    expect(shownPath("C:\\work\\demo\\notes\\r1.md", "C:/work/demo")).toBe("notes/r1.md");
    expect(shownPath("/Users/me/app/src/a.ts", "/Users/me/app/")).toBe("src/a.ts");
  });

  it("leaves a file outside the folder as written", () => {
    expect(shownPath("D:\\other\\b.ts", "C:\\work\\demo")).toBe("D:\\other\\b.ts");
    expect(shownPath("/tmp/x", "/Users/me/app")).toBe("/tmp/x");
  });
});

describe("workspacePathParts", () => {
  it.each([
    ["/work/docs/plan.md", "/work/", "docs/", "plan.md"],
    ["/work/plan.md", "/work", "", "plan.md"],
    ["/work/plan.md", "/", "work/", "plan.md"],
    ["/work-old/plan.md", "/work", "/work-old/", "plan.md"],
    ["/plan.md", "", "/", "plan.md"],
    ["c:\\Work\\docs\\plan.md", "C:/work/", "docs/", "plan.md"],
    ["D:\\Work\\plan.md", "C:/Work", "D:/Work/", "plan.md"],
    ["\\\\server\\share\\프로젝트\\src\\한글.ts", "\\\\server\\share\\프로젝트", "src/", "한글.ts"],
    ["\\\\server\\share\\a.ts", "\\\\server\\share\\", "", "a.ts"],
    ["\\\\SERVER\\Share\\App\\src\\a.ts", "\\\\server\\share\\app", "src/", "a.ts"],
    ["//server/share/app/src/a.ts", "\\\\server\\share\\app", "src/", "a.ts"],
    ["\\\\server\\other\\a.ts", "\\\\server\\share", "//server/other/", "a.ts"],
    ["/Work/plan.md", "/work", "/Work/", "plan.md"],
  ])("splits %s against %s", (path, root, directory, fileName) => {
    expect(workspacePathParts(path, root)).toEqual({ directory, fileName });
  });
});
