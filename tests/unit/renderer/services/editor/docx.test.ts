import { describe, expect, it } from "bun:test";
import { isDocxFile } from "../../../../../src/renderer/services/editor/preview/docx";

describe("isDocxFile", () => {
  it("knows .docx and .docm, case aside, and not legacy .doc", () => {
    expect(isDocxFile("/w/a/Report.DOCX")).toBe(true);
    expect(isDocxFile("/w/a/macros.docm")).toBe(true);
    expect(isDocxFile("/w/a/old.doc")).toBe(false);
    expect(isDocxFile("/w/a/docx")).toBe(false);
  });
});
