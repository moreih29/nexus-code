import { describe, expect, it } from "bun:test";
import { incrementFileName } from "../../../../../src/renderer/services/fs-mutations/increment-name";

describe("incrementFileName (VSCode 'simple' parity)", () => {
  it("appends ' copy' before the extension on first collision", () => {
    expect(incrementFileName("analysis.html")).toBe("analysis copy.html");
  });

  it("turns ' copy' into ' copy 2'", () => {
    expect(incrementFileName("analysis copy.html")).toBe("analysis copy 2.html");
  });

  it("increments an existing ' copy N'", () => {
    expect(incrementFileName("analysis copy 2.html")).toBe("analysis copy 3.html");
    expect(incrementFileName("analysis copy 9.html")).toBe("analysis copy 10.html");
  });

  it("handles files with no extension", () => {
    expect(incrementFileName("Makefile")).toBe("Makefile copy");
    expect(incrementFileName("Makefile copy")).toBe("Makefile copy 2");
  });

  it("handles multi-dot names by splitting on the last dot", () => {
    expect(incrementFileName("archive.tar.gz")).toBe("archive.tar copy.gz");
  });

  it("treats a leading-dot dotfile as having no extension", () => {
    expect(incrementFileName(".gitignore")).toBe(".gitignore copy");
  });

  it("does not split a folder name on dots", () => {
    expect(incrementFileName("my.folder", true)).toBe("my.folder copy");
    expect(incrementFileName("src", true)).toBe("src copy");
    expect(incrementFileName("src copy", true)).toBe("src copy 2");
  });
});
