import { describe, expect, test } from "bun:test";
import {
  IPC_ABORT_SENTINEL,
  IPC_ABORT_SENTINEL_TAG,
  isIpcAbortSentinel,
} from "../../../src/shared/ipc-abort-sentinel";

describe("isIpcAbortSentinel", () => {
  test("returns true for IPC_ABORT_SENTINEL", () => {
    // The sentinel must be recognised so the renderer can re-throw AbortError.
    expect(isIpcAbortSentinel(IPC_ABORT_SENTINEL)).toBe(true);
  });

  test("returns false when discriminant value is false (boolean must be exactly true)", () => {
    // A { tag: false } object must NOT match — only tag: true counts.
    const falseTagged = { [IPC_ABORT_SENTINEL_TAG]: false };
    expect(isIpcAbortSentinel(falseTagged)).toBe(false);
  });

  test("returns false for an object with an unrelated key", () => {
    // Prevents false positives from arbitrary objects passing through IPC.
    expect(isIpcAbortSentinel({ unrelatedKey: true })).toBe(false);
  });

  test("returns false for null", () => {
    // null must never match — the guard would crash without this check.
    expect(isIpcAbortSentinel(null)).toBe(false);
  });

  test("returns false for a plain string", () => {
    // Non-object values must be rejected without throwing.
    expect(isIpcAbortSentinel("__nexusIpcAborted_5d7e9c2a")).toBe(false);
  });
});

describe("IPC_ABORT_SENTINEL", () => {
  test("is frozen so main and renderer cannot accidentally mutate it", () => {
    expect(Object.isFrozen(IPC_ABORT_SENTINEL)).toBe(true);
  });

  test("discriminant tag is a plain string (not a Symbol) so structured-clone preserves it", () => {
    // Symbols are dropped by Electron's structured-clone serialisation; a
    // string key survives.  This test catches a regression if the tag type
    // is accidentally changed to a Symbol.
    expect(typeof IPC_ABORT_SENTINEL_TAG).toBe("string");
    expect(Object.keys(IPC_ABORT_SENTINEL)).toContain(IPC_ABORT_SENTINEL_TAG);
  });
});
