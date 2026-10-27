/**
 * diffWorkingFilePath — which diffs edit the working-tree file, and where
 * that file is.
 */
import { describe, expect, it } from "bun:test";
import { diffWorkingFilePath } from "../../../../../src/renderer/services/editor/tabs/diff-working-file";

describe("diffWorkingFilePath", () => {
  it("joins a working-tree diff's path onto the workspace root", () => {
    expect(diffWorkingFilePath({ relPath: "src/a.ts", rightRef: "WORKING" }, "/repo")).toBe(
      "/repo/src/a.ts",
    );
    expect(diffWorkingFilePath({ relPath: "a.ts", rightRef: "WORKING" }, "/repo/")).toBe(
      "/repo/a.ts",
    );
  });

  it("leaves a diff whose right side is a git revision read-only", () => {
    expect(diffWorkingFilePath({ relPath: "a.ts", rightRef: "INDEX" }, "/repo")).toBeNull();
  });

  it("needs the workspace", () => {
    expect(diffWorkingFilePath({ relPath: "a.ts", rightRef: "WORKING" }, null)).toBeNull();
  });
});
