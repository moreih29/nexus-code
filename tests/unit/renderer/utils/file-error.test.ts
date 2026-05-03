import { describe, expect, it } from "bun:test";
import { fileErrorMessage, parseFileErrorCode } from "../../../../src/renderer/utils/file-error";

describe("parseFileErrorCode", () => {
  it('1. "NOT_FOUND: ..." → "NOT_FOUND"', () => {
    expect(parseFileErrorCode("NOT_FOUND: file gone")).toBe("NOT_FOUND");
  });

  it('2. "PERMISSION_DENIED: ..." → "PERMISSION_DENIED"', () => {
    expect(parseFileErrorCode("PERMISSION_DENIED: /secret")).toBe("PERMISSION_DENIED");
  });

  it('3. "IS_DIRECTORY: ..." → "IS_DIRECTORY"', () => {
    expect(parseFileErrorCode("IS_DIRECTORY: /some/dir")).toBe("IS_DIRECTORY");
  });

  it('4. "TOO_LARGE: ..." → "TOO_LARGE"', () => {
    expect(parseFileErrorCode("TOO_LARGE: /big/file (6000000 bytes)")).toBe("TOO_LARGE");
  });

  it('5. unrecognised message → "OTHER"', () => {
    expect(parseFileErrorCode("some random error")).toBe("OTHER");
  });

  it('6. empty string → "OTHER"', () => {
    expect(parseFileErrorCode("")).toBe("OTHER");
  });

  it('7. prefix in middle of message → "OTHER" (anchor ^ enforced)', () => {
    expect(parseFileErrorCode("Description: NOT_FOUND: /path")).toBe("OTHER");
  });
});

describe("fileErrorMessage", () => {
  it('8. NOT_FOUND → "File not found."', () => {
    expect(fileErrorMessage("NOT_FOUND")).toBe("File not found.");
  });

  it('9. PERMISSION_DENIED → "Permission denied."', () => {
    expect(fileErrorMessage("PERMISSION_DENIED")).toBe("Permission denied.");
  });

  it("10. TOO_LARGE with maxMb=5 → contains \"max 5 MB\"", () => {
    expect(fileErrorMessage("TOO_LARGE", 5)).toContain("max 5 MB");
  });

  it('11. OTHER → "Failed to open file."', () => {
    expect(fileErrorMessage("OTHER")).toBe("Failed to open file.");
  });
});
