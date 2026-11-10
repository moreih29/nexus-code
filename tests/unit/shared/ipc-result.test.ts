import { describe, expect, test } from "bun:test";
import {
  IPC_RESULT_BRAND,
  ipcErr,
  ipcResultKindToCategory,
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
});

// ---------------------------------------------------------------------------
// ipcErr constructor
// ---------------------------------------------------------------------------

describe("ipcErr", () => {
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
  test("returns false for a plain object with only ok:true", () => {
    // Domain objects that happen to have ok:true must NOT match.
    expect(isIpcResult({ ok: true })).toBe(false);
  });

  test("returns false for an object with brand=false", () => {
    // The brand value must be exactly true, not merely truthy.
    expect(isIpcResult({ [IPC_RESULT_BRAND]: false, ok: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IpcResultKind → AppErrorCategory mapping
// ---------------------------------------------------------------------------

describe("ipcResultKindToCategory", () => {
  test("maps cancelled and invalid-args to their own categories, everything else to failed", () => {
    const cases = [
      ["cancelled", "cancelled"],
      ["invalid-args", "invalid-input"],
      ["not-found", "failed"],
      // Custom kinds introduced by future handlers must not produce 'bug' silently.
      ["some-future-kind", "failed"],
    ] as const;
    for (const [kind, category] of cases) {
      expect(ipcResultKindToCategory(kind), kind).toBe(category);
    }
  });
});
