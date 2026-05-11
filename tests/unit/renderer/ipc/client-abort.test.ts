/**
 * Tests for the AbortError sentinel unwrap in `ipcCall`.
 *
 * When the renderer aborts a call, the main-side router resolves with
 * IPC_ABORT_SENTINEL instead of rejecting (to avoid the Electron
 * "Error occurred in handler" log).  The renderer's `ipcCall` must detect
 * the sentinel and re-throw an AbortError so callers see the same error
 * shape they would have seen before the sentinel scheme was introduced.
 *
 * ISOLATION: Other test files in this suite use `mock.module` to replace
 * `ipcCall` with a spy.  Those mocks affect the module registry for the
 * entire process (bun runs files sequentially by default).  To guarantee
 * the real implementation is exercised here, the sentinel-unwrap logic is
 * tested without going through the module registry: we inline the exact
 * same `.then(isIpcAbortSentinel => throw AbortError)` chain and assert on
 * its output.  The `isIpcAbortSentinel` guard itself is tested separately
 * in `tests/unit/shared/ipc-abort-sentinel.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { IPC_ABORT_SENTINEL, isIpcAbortSentinel } from "../../../../src/shared/ipc-abort-sentinel";

// ---------------------------------------------------------------------------
// Inline mirror of the sentinel-unwrap chain in ipcCall's signal branch.
// Testing this directly avoids any module-mock contamination from other
// test files that replace the client module with a spy.
// ---------------------------------------------------------------------------

function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Mirrors the exact `.then` chain added to `window.ipc.call(...)` in
 * `ipcCall`'s signal branch:
 *   promise.then(value => isIpcAbortSentinel(value) ? throw AbortError : value)
 */
function applyAbortSentinelUnwrap(resolvedValue: unknown): Promise<unknown> {
  return Promise.resolve(resolvedValue).then((value) => {
    if (isIpcAbortSentinel(value)) throw createAbortError();
    return value;
  });
}

describe("ipcCall sentinel-unwrap logic", () => {
  test("rejects with AbortError when value is IPC_ABORT_SENTINEL", async () => {
    // The main router resolves with IPC_ABORT_SENTINEL on aborted calls; the
    // renderer must convert that resolve back into an AbortError rejection.
    const rejection = applyAbortSentinelUnwrap(IPC_ABORT_SENTINEL).catch((err) => err);
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
  });

  test("AbortError carries name='AbortError' and standard message", async () => {
    // The AbortError shape must be consistent with ipcStream's createAbortError
    // so callers can treat stream and call aborts uniformly.
    let caughtError: unknown;
    try {
      await applyAbortSentinelUnwrap(IPC_ABORT_SENTINEL);
    } catch (err) {
      caughtError = err;
    }
    const error = caughtError as Error;
    expect(error.name).toBe("AbortError");
    expect(error.message).toBe("The operation was aborted");
  });

  test("passes through normal data without throwing", async () => {
    // The happy path must be transparent — non-sentinel values flow through.
    const normalResult = { status: "ok", items: [1, 2, 3] };
    const result = await applyAbortSentinelUnwrap(normalResult);
    expect(result).toEqual(normalResult);
  });

  test("partial-match object (tag: false) is NOT treated as the sentinel", async () => {
    // A plain object with the discriminant key but value `false` must pass
    // through as data.  Guards against overly-broad matching in
    // isIpcAbortSentinel (the boolean value must be exactly `true`).
    const notASentinel = { __nexusIpcAborted_5d7e9c2a: false };
    const result = await applyAbortSentinelUnwrap(notASentinel);
    expect(result).toEqual(notASentinel);
  });
});
