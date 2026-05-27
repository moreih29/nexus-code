/**
 * Tests for the shared FS error utilities — FS_ERROR codes, fsErrorMessage,
 * hasFsErrorCode — including the UNSUPPORTED_REMOTE code added for remote
 * workspace detection.
 */

import { describe, expect, it } from "bun:test";
import { FS_ERROR, fsErrorMessage, hasFsErrorCode } from "../../../src/shared/fs/errors";

describe("FS_ERROR constants", () => {
  it("UNSUPPORTED_REMOTE is defined with the correct string value", () => {
    expect(FS_ERROR.UNSUPPORTED_REMOTE).toBe("UNSUPPORTED_REMOTE");
  });

  it("all pre-existing codes remain unchanged", () => {
    expect(FS_ERROR.NOT_FOUND).toBe("NOT_FOUND");
    expect(FS_ERROR.PERMISSION_DENIED).toBe("PERMISSION_DENIED");
    expect(FS_ERROR.ALREADY_EXISTS).toBe("ALREADY_EXISTS");
    expect(FS_ERROR.NOT_EMPTY).toBe("NOT_EMPTY");
    expect(FS_ERROR.CROSS_DEVICE).toBe("CROSS_DEVICE");
  });
});

describe("fsErrorMessage", () => {
  it("builds UNSUPPORTED_REMOTE message with workspaceId suffix", () => {
    const wsId = "123e4567-e89b-12d3-a456-426614174000";
    expect(fsErrorMessage(FS_ERROR.UNSUPPORTED_REMOTE, wsId)).toBe(
      `UNSUPPORTED_REMOTE: ${wsId}`,
    );
  });
});

describe("hasFsErrorCode", () => {
  it("matches UNSUPPORTED_REMOTE prefix in a plain error message", () => {
    const wsId = "123e4567-e89b-12d3-a456-426614174000";
    const err = new Error(fsErrorMessage(FS_ERROR.UNSUPPORTED_REMOTE, wsId));
    expect(hasFsErrorCode(err, FS_ERROR.UNSUPPORTED_REMOTE)).toBe(true);
  });

  it("does not match UNSUPPORTED_REMOTE against an unrelated code", () => {
    const err = new Error("NOT_FOUND: /some/path");
    expect(hasFsErrorCode(err, FS_ERROR.UNSUPPORTED_REMOTE)).toBe(false);
  });

  it("does not match UNSUPPORTED_REMOTE when the code appears mid-sentence", () => {
    const err = new Error("message about UNSUPPORTED_REMOTE context");
    expect(hasFsErrorCode(err, FS_ERROR.UNSUPPORTED_REMOTE)).toBe(false);
  });
});
