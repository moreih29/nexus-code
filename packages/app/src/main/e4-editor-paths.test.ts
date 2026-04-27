import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import { resolveE4WorkspacePath } from "./e4-editor-paths";

const workspaceRoot = path.join(os.tmpdir(), "nexus-e4-paths-workspace");

describe("E4 editor path guard", () => {
  test("normalizes safe workspace-relative paths", () => {
    expect(resolveE4WorkspacePath(workspaceRoot, "src/../README.md")).toEqual({
      workspaceRoot,
      absolutePath: path.join(workspaceRoot, "README.md"),
      relativePath: "README.md",
    });
  });

  test("allows the workspace root only when explicitly requested", () => {
    expect(resolveE4WorkspacePath(workspaceRoot, "", { allowRoot: true })).toEqual({
      workspaceRoot,
      absolutePath: workspaceRoot,
      relativePath: "",
    });

    expect(() => resolveE4WorkspacePath(workspaceRoot, "")).toThrow("path cannot be empty");
  });

  test("rejects traversal and renderer supplied absolute paths", () => {
    expect(() => resolveE4WorkspacePath(workspaceRoot, "../outside.txt")).toThrow(
      "path cannot traverse outside the workspace",
    );
    expect(() => resolveE4WorkspacePath(workspaceRoot, "/tmp/outside.txt")).toThrow(
      "path must be a workspace-relative path",
    );
    expect(() => resolveE4WorkspacePath(workspaceRoot, "C:\\tmp\\outside.txt")).toThrow(
      "path must be a workspace-relative path",
    );
  });
});
