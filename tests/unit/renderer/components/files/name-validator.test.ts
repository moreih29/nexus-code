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

describe("validateNewEntryName on a Windows file system", () => {
  const windows = (name: string) => validateNewEntryName(name, undefined, { windows: true });

  it("rejects the characters Windows refuses in a name", () => {
    for (const name of ["a:b.txt", "a*", "what?", 'say"hi"', "<x>", "a|b", "tab\there"]) {
      expect(windows(name)).toBe('Name cannot contain : * ? " < > |');
    }
    expect(windows("src/a:b.ts")).not.toBeNull();
  });

  it("rejects device names, with or without an extension", () => {
    for (const name of ["CON", "nul", "Aux.txt", "com1", "LPT9.log", "dir/prn"]) {
      expect(windows(name)).toBe("This name is reserved on Windows.");
    }
  });

  it("rejects a segment that ends in a dot or a space", () => {
    expect(windows("foo.")).toBe("Name cannot end with a dot or a space.");
    expect(windows("foo ")).toBe("Name cannot end with a dot or a space.");
    expect(windows("dir./a.ts")).toBe("Name cannot end with a dot or a space.");
  });

  it("accepts the names Windows takes", () => {
    const names = ["readme.md", ".env", "console.log", "com10", "nul-check", "a b/c.d.ts", "foo/"];
    for (const name of names) {
      expect(windows(name)).toBeNull();
    }
  });

  it("leaves these names to other file systems", () => {
    for (const name of ["a:b.txt", "CON", "foo."]) {
      expect(validateNewEntryName(name)).toBeNull();
    }
  });
});
