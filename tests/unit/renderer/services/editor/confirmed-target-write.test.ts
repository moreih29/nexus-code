import { describe, expect, it, mock } from "bun:test";
import { writeConfirmedSaveTarget } from "../../../../../src/renderer/services/editor/save/confirmed-target-write";
import type { ExpectedFileStateContract } from "../../../../../src/shared/fs/types";

describe("writeConfirmedSaveTarget", () => {
  it("writes a new file once", async () => {
    const expectations: ExpectedFileStateContract[] = [];
    const result = await writeConfirmedSaveTarget(
      async (expected) => {
        expectations.push(expected);
        return { kind: "ok", mtime: "m1", size: 3 };
      },
      async () => true,
    );
    expect(result).toEqual({ kind: "ok", mtime: "m1", size: 3 });
    expect(expectations).toEqual([{ exists: false }]);
  });

  it("does not retry a collision if the user declines replacement", async () => {
    const write = mock(async () => ({
      kind: "conflict" as const,
      actual: { exists: true as const, mtime: "remote", size: 9 },
    }));
    const confirm = mock(async () => false);
    expect(await writeConfirmedSaveTarget(write, confirm)).toBeNull();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("replaces a file after explicit confirmation, guarded by its reported state", async () => {
    const existing = { exists: true as const, mtime: "m0", size: 9 };
    const expectations: ExpectedFileStateContract[] = [];
    const result = await writeConfirmedSaveTarget(
      async (expected) => {
        expectations.push(expected);
        return expected.exists
          ? { kind: "ok", mtime: "m1", size: 3 }
          : { kind: "conflict", actual: existing };
      },
      async () => true,
    );
    expect(result).toEqual({ kind: "ok", mtime: "m1", size: 3 });
    expect(expectations).toEqual([{ exists: false }, existing]);
  });

  it("reports a file that changed while replacement was being confirmed", async () => {
    let call = 0;
    const result = await writeConfirmedSaveTarget(
      async () => {
        call += 1;
        return {
          kind: "conflict",
          actual: { exists: true, mtime: `m${call}`, size: call },
        };
      },
      async () => true,
    );
    expect(result?.kind).toBe("conflict");
    expect(call).toBe(2);
  });
});
