import { describe, expect, it } from "bun:test";
import { revealInOSLabel } from "../../../../src/renderer/utils/reveal-label";

describe("revealInOSLabel", () => {
  it("names each platform's file manager", () => {
    expect(revealInOSLabel("darwin")).toBe("Reveal in Finder");
    expect(revealInOSLabel("win32")).toBe("Reveal in File Explorer");
    expect(revealInOSLabel("linux")).toBe("Open Containing Folder");
  });
});
