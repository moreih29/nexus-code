import { describe, expect, it } from "bun:test";
import {
  fileErrorMessage,
  fsErrorReason,
  parseFileErrorCode,
} from "../../../../src/renderer/utils/file-error";

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

  it("7. arbitrary mid-string prefix does not match", () => {
    expect(parseFileErrorCode("Description: NOT_FOUND: /path")).toBe("OTHER");
  });

  it("8. Electron-wrapped remote errors preserve known code", () => {
    expect(
      parseFileErrorCode(
        "Error invoking remote method 'ipc:call': Error: NOT_FOUND: /tmp/vanish.ts",
      ),
    ).toBe("NOT_FOUND");
  });

  it("9. Electron-wrapped permission errors preserve known code", () => {
    expect(
      parseFileErrorCode(
        "Error invoking remote method 'ipc:call': Error: PERMISSION_DENIED: /secret",
      ),
    ).toBe("PERMISSION_DENIED");
  });
});

describe("fileErrorMessage", () => {
  it('12. TOO_LARGE with maxMb=5 → contains "max 5 MB"', () => {
    expect(fileErrorMessage("TOO_LARGE", 5)).toContain("max 5 MB");
  });

  it('13. OTHER → "Failed to open file."', () => {
    expect(fileErrorMessage("OTHER")).toBe("Failed to open file.");
  });
});

describe("fsErrorReason", () => {
  it("gives the localized phrase for a coded fs error, without its code and path", () => {
    expect(fsErrorReason(new Error("PERMISSION_DENIED: /Users/me/proj/src/a.ts"))).toBe(
      "Permission denied.",
    );
    expect(fsErrorReason(new Error("NO_SPACE: /Users/me/proj/a.ts"))).toBe(
      "Not enough disk space.",
    );
  });

  it("keeps the message of an unclassified error", () => {
    expect(fsErrorReason(new Error("Agent request timed out"))).toBe("Agent request timed out");
  });
});
