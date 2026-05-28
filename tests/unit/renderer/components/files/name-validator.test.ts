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

  it("accepts nested paths so intermediate directories can be created on commit (VSCode parity)", () => {
    expect(validateNewEntryName("a/b")).toBeNull();
    expect(validateNewEntryName("src/components/foo.ts")).toBeNull();
    // Single trailing slash is the VSCode "force folder" hint — tolerated here
    // because the IPC layer treats the value as a path and the caller already
    // chose file vs folder via the inline-create kind.
    expect(validateNewEntryName("foo/")).toBeNull();
  });

  it("rejects absolute paths (leading '/' or '\\\\')", () => {
    expect(validateNewEntryName("/abs")).not.toBeNull();
    expect(validateNewEntryName("\\bad")).not.toBeNull();
  });

  it("rejects empty interior segments and reserved segment names", () => {
    // "a//b" → segments ["a","","b"] — empty interior segment is invalid.
    expect(validateNewEntryName("a//b")).not.toBeNull();
    // Any segment being "." or ".." escapes the parent — rejected.
    expect(validateNewEntryName("foo/./bar")).not.toBeNull();
    expect(validateNewEntryName("foo/../bar")).not.toBeNull();
  });

  it("rejects names with NUL byte", () => {
    expect(validateNewEntryName("a\0b")).not.toBeNull();
  });
});
