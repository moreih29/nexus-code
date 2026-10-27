import { describe, expect, it } from "bun:test";
import { writeConfirmedSaveTarget } from "../../../../../src/renderer/services/editor/save/confirmed-target-write";
import type { ExpectedFileStateContract } from "../../../../../src/shared/fs/types";

describe("writeConfirmedSaveTarget", () => {
  it("writes a new file once", async () => {
    const expectations: ExpectedFileStateContract[] = [];
    const result = await writeConfirmedSaveTarget(async (expected) => {
      expectations.push(expected);
      return { kind: "ok", mtime: "m1", size: 3 };
    });
    expect(result).toEqual({ kind: "ok", mtime: "m1", size: 3 });
    expect(expectations).toEqual([{ exists: false }]);
  });

  it("replaces a file the dialog confirmed, guarded by its reported state", async () => {
    const existing = { exists: true as const, mtime: "m0", size: 9 };
    const expectations: ExpectedFileStateContract[] = [];
    const result = await writeConfirmedSaveTarget(async (expected) => {
      expectations.push(expected);
      return expected.exists
        ? { kind: "ok", mtime: "m1", size: 3 }
        : { kind: "conflict", actual: existing };
    });
    expect(result).toEqual({ kind: "ok", mtime: "m1", size: 3 });
    expect(expectations).toEqual([{ exists: false }, existing]);
  });

  it("reports a file that changed again between the two writes", async () => {
    let call = 0;
    const result = await writeConfirmedSaveTarget(async () => {
      call += 1;
      return {
        kind: "conflict",
        actual: { exists: true, mtime: `m${call}`, size: call },
      };
    });
    expect(result.kind).toBe("conflict");
    expect(call).toBe(2);
  });
});
