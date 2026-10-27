/**
 * When a main handler throws, Electron rejects the renderer's invoke with
 * "Error invoking remote method 'ipc:call': <name>: <message>". ipcCallResult
 * restores the thrown name and message through unwrapRemoteError, so error
 * banners do not show the IPC plumbing.
 */
import { describe, expect, test } from "bun:test";
import { unwrapRemoteError } from "../../../../src/renderer/ipc/remote-error";

describe("unwrapRemoteError", () => {
  test("restores the name and message main threw", () => {
    const error = new Error(
      "Error invoking remote method 'ipc:call': SshError: Agent request timed out",
    );

    expect(unwrapRemoteError(error)).toBe(error);
    expect(error).toMatchObject({ name: "SshError", message: "Agent request timed out" });
  });

  test("keeps a multi-line message whole", () => {
    const error = new Error(
      "Error invoking remote method 'ipc:call': Error: fatal: unable to access 'x'\nhint: retry",
    );

    expect(unwrapRemoteError(error)).toMatchObject({
      name: "Error",
      message: "fatal: unable to access 'x'\nhint: retry",
    });
  });

  test("keeps a bracketed error name", () => {
    const error = new Error(
      "Error invoking remote method 'ipc:call': IpcError[bug]: handler failed",
    );

    expect(unwrapRemoteError(error)).toMatchObject({
      name: "IpcError[bug]",
      message: "handler failed",
    });
  });

  test("leaves other errors as they are", () => {
    const error = new Error("NOT_FOUND: /tmp/vanish.ts");

    expect(unwrapRemoteError(error)).toBe(error);
    expect(error).toMatchObject({ name: "Error", message: "NOT_FOUND: /tmp/vanish.ts" });
    expect(unwrapRemoteError("not an error")).toBe("not an error");
  });
});
