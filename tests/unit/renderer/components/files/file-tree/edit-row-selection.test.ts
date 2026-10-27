/**
 * renameSelectionEnd — how much of a name the rename input selects.
 */
import { describe, expect, it } from "bun:test";
import { renameSelectionEnd } from "../../../../../../src/renderer/components/files/file-tree/edit-row";

describe("renameSelectionEnd", () => {
  it("stops before a file's extension", () => {
    expect(renameSelectionEnd("index.ts", "file")).toBe(5);
    expect(renameSelectionEnd("archive.tar.gz", "file")).toBe(11);
  });

  it("selects a whole name without an extension", () => {
    expect(renameSelectionEnd("Makefile", "file")).toBe(8);
    expect(renameSelectionEnd(".gitignore", "file")).toBe(10);
  });

  it("selects a whole folder name, dots included", () => {
    expect(renameSelectionEnd("v1.2", "folder")).toBe(4);
  });
});
