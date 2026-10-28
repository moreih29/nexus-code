import { describe, expect, it } from "bun:test";
import path from "node:path";
import type { WorkspaceManager } from "../../../../src/main/features/workspace/manager";
import { resolveLocalWorkspacePath } from "../../../../src/main/features/workspace/path-safety";

const WS = "00000000-0000-0000-0000-0000000000ac";
// An absolute path on the host OS: /repo, or a drive's \repo on Windows.
const ROOT = path.resolve("/repo");

const manager = {
  list: () => [{ id: WS, location: { kind: "local", rootPath: ROOT } }],
} as unknown as WorkspaceManager;

describe("resolveLocalWorkspacePath", () => {
  it("accepts names that only start with two dots", () => {
    expect(resolveLocalWorkspacePath(manager, WS, "..cache")).toBe(path.join(ROOT, "..cache"));
    expect(resolveLocalWorkspacePath(manager, WS, "src/..foo/a.ts")).toBe(
      path.join(ROOT, "src", "..foo", "a.ts"),
    );
  });

  it("rejects paths that leave the root", () => {
    expect(() => resolveLocalWorkspacePath(manager, WS, "..")).toThrow(
      "path escapes workspace root",
    );
    expect(() => resolveLocalWorkspacePath(manager, WS, "../other")).toThrow(
      "path escapes workspace root",
    );
    expect(() => resolveLocalWorkspacePath(manager, WS, "/etc/passwd")).toThrow(
      "path escapes workspace root",
    );
  });

  it("resolves the root itself", () => {
    expect(resolveLocalWorkspacePath(manager, WS, "")).toBe(ROOT);
  });
});
