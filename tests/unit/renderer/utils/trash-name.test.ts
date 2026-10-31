import { describe, expect, it } from "bun:test";
import { trashName } from "../../../../src/renderer/utils/trash-name";

describe("trashName", () => {
  it("names where each platform keeps deleted files", () => {
    expect(trashName("darwin")).toBe("Trash");
    expect(trashName("win32")).toBe("Recycle Bin");
    expect(trashName("linux")).toBe("Trash");
  });
});
