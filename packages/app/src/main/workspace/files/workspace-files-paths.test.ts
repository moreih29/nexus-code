import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceFilePath } from "./workspace-files-paths";

const workspaceRoot = path.join(os.tmpdir(), "nexus-workspace-file-paths");

describe("workspace file path guard", () => {
  test("normalizes safe workspace-relative paths", () => {
    expect(resolveWorkspaceFilePath(workspaceRoot, "src/../README.md")).toEqual({
      workspaceRoot,
      absolutePath: path.join(workspaceRoot, "README.md"),
      relativePath: "README.md",
    });
  });

  test("allows the workspace root only when explicitly requested", () => {
    expect(resolveWorkspaceFilePath(workspaceRoot, "", { allowRoot: true })).toEqual({
      workspaceRoot,
      absolutePath: workspaceRoot,
      relativePath: "",
    });

    expect(() => resolveWorkspaceFilePath(workspaceRoot, "")).toThrow("path cannot be empty");
  });

  test("rejects traversal and renderer supplied absolute paths", () => {
    expect(() => resolveWorkspaceFilePath(workspaceRoot, "../outside.txt")).toThrow(
      "path cannot traverse outside the workspace",
    );
    expect(() => resolveWorkspaceFilePath(workspaceRoot, "/tmp/outside.txt")).toThrow(
      "path must be a workspace-relative path",
    );
    expect(() => resolveWorkspaceFilePath(workspaceRoot, "C:\\tmp\\outside.txt")).toThrow(
      "path must be a workspace-relative path",
    );
  });
});
