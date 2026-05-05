/**
 * Pure tests for validateNewEntryName.
 */
import { describe, expect, it } from "bun:test";
import { validateNewEntryName } from "../../../../../src/renderer/components/files/name-validator";

describe("validateNewEntryName", () => {
  it("accepts ordinary file names", () => {
    expect(validateNewEntryName("readme.md")).toBeNull();
    expect(validateNewEntryName("a")).toBeNull();
    expect(validateNewEntryName("with space.txt")).toBeNull();
  });

  it("accepts dotfiles (leading dot is fine)", () => {
    expect(validateNewEntryName(".env")).toBeNull();
    expect(validateNewEntryName(".gitignore")).toBeNull();
  });

  it("rejects empty / whitespace-only", () => {
    expect(validateNewEntryName("")).not.toBeNull();
    expect(validateNewEntryName("   ")).not.toBeNull();
  });

  it("rejects '.' and '..' as full names", () => {
    expect(validateNewEntryName(".")).not.toBeNull();
    expect(validateNewEntryName("..")).not.toBeNull();
  });

  it("rejects names containing '/' or '\\\\' (would escape parent)", () => {
    expect(validateNewEntryName("a/b")).not.toBeNull();
    expect(validateNewEntryName("\\bad")).not.toBeNull();
  });

  it("rejects names with NUL byte", () => {
    expect(validateNewEntryName("a\0b")).not.toBeNull();
  });
});
