import { describe, expect, test } from "bun:test";

// electron stub is provided by tests/setup.ts (preloaded via bunfig.toml).
// withCancelDefault does not call broadcast() so webContents is never
// exercised here; the preload stub's no-op getAllWebContents is sufficient.

const { withCancelDefault } = await import("../../../../src/main/features/lsp/ipc");

describe("withCancelDefault", () => {
  test("returns the resolved value when the call succeeds", async () => {
    const ctrl = new AbortController();
    const result = await withCancelDefault(Promise.resolve(["item"]), ctrl.signal, []);
    expect(result).toEqual(["item"]);
  });

  test("returns the empty value when signal aborts and call rejects", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await withCancelDefault<string[]>(
      Promise.reject(new Error("Request cancelled")),
      ctrl.signal,
      [],
    );
    expect(result).toEqual([]);
  });

  test("supports null as the empty value (hover-style)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await withCancelDefault<string | null>(
      Promise.reject(new Error("Request cancelled")),
      ctrl.signal,
      null,
    );
    expect(result).toBeNull();
  });

  test("rethrows when the signal is not aborted", async () => {
    const ctrl = new AbortController();
    await expect(
      withCancelDefault(Promise.reject(new Error("LSP server crashed")), ctrl.signal, []),
    ).rejects.toThrow("LSP server crashed");
  });

  test("rethrows when no signal is provided (notify-style callers)", async () => {
    await expect(
      withCancelDefault(Promise.reject(new Error("boom")), undefined, []),
    ).rejects.toThrow("boom");
  });
});
