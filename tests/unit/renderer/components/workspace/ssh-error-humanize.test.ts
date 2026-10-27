/**
 * SSH connect and reconnect failures arrive as `ipcErr("auth-failed", …)`
 * results whose SshErrorCode rides in a `code` field; the humanizer maps them
 * to the localized cause and recovery text instead of main's terse English.
 */
import { describe, expect, it } from "bun:test";
import { humanizeSshError } from "../../../../../src/renderer/components/workspace/add-workspace/ssh-helpers";

describe("humanizeSshError", () => {
  it("maps the code of an ipcErr result", () => {
    expect(
      humanizeSshError({
        ok: false,
        kind: "auth-failed",
        message: "SSH authentication failed",
        code: "ssh.auth-failed",
      }),
    ).toBe("Authentication failed. Verify your credentials or identity file and try again.");
    expect(
      humanizeSshError({ ok: false, kind: "auth-failed", message: "x", code: "ssh.unknown" }),
    ).toBe("An unknown SSH error occurred. Check connectivity and retry.");
  });

  it("still reads a code embedded in an Error message", () => {
    expect(humanizeSshError(new Error("SSH connection failed [ssh.connect-failed]"))).toBe(
      "Couldn't connect to the host. Check the address and your network, then retry.",
    );
  });

  it("falls back to generic text without a code", () => {
    expect(humanizeSshError({ ok: false, kind: "auth-failed", message: "boom" })).toBe(
      "Something went wrong. Please try again.",
    );
    expect(humanizeSshError(new Error("boom"))).toBe(
      "Connection failed. Check your settings and try again.",
    );
  });
});
