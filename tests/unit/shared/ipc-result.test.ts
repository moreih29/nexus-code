import { describe, expect, test } from "bun:test";
import {
  IPC_RESULT_BRAND,
  ipcErr,
  ipcResultKindToCategory,
  isIpcResult,
} from "../../../src/shared/ipc/result";

describe("IPC_RESULT_BRAND", () => {
  test("is a plain string (not a Symbol) so structured-clone preserves it", () => {
    expect(typeof IPC_RESULT_BRAND).toBe("string");
  });
});

describe("ipcErr", () => {
  test("merges extra domain fields onto the envelope", () => {
    const result = ipcErr("auth-failed", "Rejected", { host: "example.com", port: 22 });
    expect((result as Record<string, unknown>)["host"]).toBe("example.com");
    expect((result as Record<string, unknown>)["port"]).toBe(22);
  });
});

describe("isIpcResult", () => {
  test("returns false for a plain object with only ok:true", () => {
    expect(isIpcResult({ ok: true })).toBe(false);
  });

  test("returns false for an object with brand=false", () => {
    expect(isIpcResult({ [IPC_RESULT_BRAND]: false, ok: true })).toBe(false);
  });
});

describe("ipcResultKindToCategory", () => {
  test("maps cancelled and invalid-args to their own categories, everything else to failed", () => {
    const cases = [
      ["cancelled", "cancelled"],
      ["invalid-args", "invalid-input"],
      ["not-found", "failed"],
      ["some-future-kind", "failed"],
    ] as const;
    for (const [kind, category] of cases) {
      expect(ipcResultKindToCategory(kind), kind).toBe(category);
    }
  });
});
