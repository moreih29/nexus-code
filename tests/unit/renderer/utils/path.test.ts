import { describe, expect, it } from "bun:test";
import { isWithinWorkspace } from "../../../../src/renderer/utils/path";

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
