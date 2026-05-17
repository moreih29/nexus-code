import { describe, expect, test } from "bun:test";
import {
  IPC_RESULT_BRAND,
  ipcErr,
  ipcOk,
  isIpcErrResult,
  isIpcOkResult,
  isIpcResult,
} from "../../../src/shared/ipc/result";

// ---------------------------------------------------------------------------
// Brand sanity
// ---------------------------------------------------------------------------

describe("IPC_RESULT_BRAND", () => {
  test("is a plain string (not a Symbol) so structured-clone preserves it", () => {
    // Symbols are silently dropped by Electron's IPC serialiser; the brand
    // must be a string so it survives the main→renderer boundary.
    expect(typeof IPC_RESULT_BRAND).toBe("string");
  });

  test("includes a UUID suffix to prevent collisions with domain objects", () => {
    // The suffix separates our brand from generic 'ok' fields in domain types.
    expect(IPC_RESULT_BRAND).toMatch(/__nexusIpcResult_[0-9a-f]+/);
  });
});

// ---------------------------------------------------------------------------
// ipcOk constructor
// ---------------------------------------------------------------------------

describe("ipcOk", () => {
  test("produces an ok=true envelope with the supplied value", () => {
    const result = ipcOk({ sessionId: "abc" });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ sessionId: "abc" });
  });

  test("carries the brand property", () => {
    const result = ipcOk(42);
    expect((result as Record<string, unknown>)[IPC_RESULT_BRAND]).toBe(true);
  });

  test("is detected by isIpcResult and isIpcOkResult", () => {
    const result = ipcOk("hello");
    expect(isIpcResult(result)).toBe(true);
    expect(isIpcOkResult(result)).toBe(true);
    expect(isIpcErrResult(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ipcErr constructor
// ---------------------------------------------------------------------------

describe("ipcErr", () => {
  test("produces an ok=false envelope with kind and message", () => {
    const result = ipcErr("not-found", "Resource missing");
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("not-found");
    expect(result.message).toBe("Resource missing");
  });

  test("carries the brand property", () => {
    const result = ipcErr("cancelled", "User cancelled");
    expect((result as Record<string, unknown>)[IPC_RESULT_BRAND]).toBe(true);
  });

  test("is detected by isIpcResult and isIpcErrResult", () => {
    const result = ipcErr("auth-failed", "Key rejected");
    expect(isIpcResult(result)).toBe(true);
    expect(isIpcErrResult(result)).toBe(true);
    expect(isIpcOkResult(result)).toBe(false);
  });

  test("merges extra domain fields onto the envelope", () => {
    const result = ipcErr("auth-failed", "Rejected", { host: "example.com", port: 22 });
    expect((result as Record<string, unknown>)["host"]).toBe("example.com");
    expect((result as Record<string, unknown>)["port"]).toBe(22);
  });
});

// ---------------------------------------------------------------------------
// isIpcResult — type guard rejects non-envelope values
// ---------------------------------------------------------------------------

describe("isIpcResult", () => {
  test("returns false for null", () => {
    expect(isIpcResult(null)).toBe(false);
  });

  test("returns false for a plain object with only ok:true", () => {
    // Domain objects that happen to have ok:true must NOT match.
    expect(isIpcResult({ ok: true })).toBe(false);
  });

  test("returns false for a string", () => {
    expect(isIpcResult("pong")).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isIpcResult(undefined)).toBe(false);
  });

  test("returns false for an object with brand=false", () => {
    // The brand value must be exactly true, not merely truthy.
    expect(isIpcResult({ [IPC_RESULT_BRAND]: false, ok: true })).toBe(false);
  });

  test("returns true for ipcOk result", () => {
    expect(isIpcResult(ipcOk(null))).toBe(true);
  });

  test("returns true for ipcErr result", () => {
    expect(isIpcResult(ipcErr("not-found", "x"))).toBe(true);
  });
});
