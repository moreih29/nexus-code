import { describe, expect, test } from "bun:test";
import "../../../log-test-spies";
import { BugReportRecentErrorSchema } from "../../../../packages/remote-protocol/src";
import {
  onUncaughtException,
  onUnhandledRejection,
} from "../../../../src/main/infra/error-safety-net";
import { noteIpcResult, noteIpcThrow } from "../../../../src/main/infra/ipc-router/recent-failures";
import { RecentErrors } from "../../../../src/main/infra/recent-errors";
import { ipcErr } from "../../../../src/shared/ipc/result";

const fresh = () => new RecentErrors(() => 0);

describe("a failed IPC call", () => {
  test("is recorded by its channel's area, method and code", () => {
    const errors = fresh();
    noteIpcResult(
      "fs",
      "writeFile",
      ipcErr("fs-error", "PERMISSION_DENIED: EACCES: permission denied, open '/Users/kim/a.md'", {
        category: "failed",
        domain: "fs",
        code: "PERMISSION_DENIED",
      }),
      errors.record,
    );
    noteIpcResult(
      "git",
      "push",
      ipcErr("auth", "fatal: Authentication failed", { category: "failed", code: "auth" }),
      errors.record,
    );
    noteIpcResult(
      "workspace",
      "open",
      ipcErr("unavailable", "host down", { category: "failed" }),
      errors.record,
    );
    expect(errors.list()).toEqual([
      { ago: 0, area: "app", code: "open:unavailable", message: "host down" },
      { ago: 0, area: "git", code: "push:auth" },
      {
        ago: 0,
        area: "files",
        code: "write_file:permission_denied",
        message: "PERMISSION_DENIED: EACCES: permission denied, open '<path>'",
      },
    ]);
    for (const entry of errors.list()) BugReportRecentErrorSchema.parse(entry);
  });

  test("keeps only the code where the message could carry a conversation, a note or a file", () => {
    const errors = fresh();
    const secret = "the user's prompt: fix the payroll export";
    for (const channel of [
      "chat",
      "claude",
      "cli",
      "notes",
      "voiceMemory",
      "git",
      "autofetch",
      "pty",
      "editor",
      "clipboard",
      "browser",
      "lsp",
      "task",
      "agentProfiles",
    ]) {
      noteIpcResult(
        channel,
        "send",
        ipcErr("failed", secret, { category: "failed" }),
        errors.record,
      );
      noteIpcThrow(channel, "send", new Error(secret), errors.record);
    }
    expect(JSON.stringify(errors.list())).not.toContain("payroll");
    expect(errors.list().map(({ area }) => area)).toContain("agent");
    expect(errors.list().map(({ area }) => area)).toContain("notes");
  });

  test("records nothing for cancelled or invalid input, for the remote channel, or for itself", () => {
    const errors = fresh();
    noteIpcResult("fs", "read", ipcErr("cancelled", "x", { category: "cancelled" }), errors.record);
    noteIpcResult(
      "fs",
      "read",
      ipcErr("invalid-args", "x", { category: "invalid-input" }),
      errors.record,
    );
    noteIpcResult("fs", "read", ipcErr("not-found", "x"), errors.record);
    noteIpcResult(
      "remote",
      "devices",
      ipcErr("failed", "x", { category: "failed" }),
      errors.record,
    );
    noteIpcThrow("system", "recordError", new Error("x"), errors.record);
    noteIpcThrow(
      "fs",
      "read",
      Object.assign(new Error("stop"), { name: "AbortError" }),
      errors.record,
    );
    expect(errors.list()).toEqual([]);
  });

  test("a thrown error is recorded by its name; a SyntaxError never with its message", () => {
    const errors = fresh();
    noteIpcThrow(
      "system",
      "stats",
      new TypeError("Cannot read properties of undefined"),
      errors.record,
    );
    noteIpcThrow(
      "fs",
      "readJson",
      new SyntaxError("Unexpected token 'a', \"a secret\" is not valid JSON"),
      errors.record,
    );
    expect(errors.list()).toEqual([
      { ago: 0, area: "files", code: "read_json:syntax_error" },
      {
        ago: 0,
        area: "app",
        code: "stats:type_error",
        message: "Cannot read properties of undefined",
      },
    ]);
  });
});

describe("an uncaught error in the main process", () => {
  test("is recorded as app with its name and redacted message", () => {
    const errors = fresh();
    onUncaughtException(new RangeError("bad index for /Users/kim/x.json"), errors.record);
    onUnhandledRejection(new SyntaxError('"secret" is not valid JSON'), errors.record);
    onUnhandledRejection("plain", errors.record);
    expect(errors.list()).toEqual([
      { ago: 0, area: "app", code: "rejection:error" },
      { ago: 0, area: "app", code: "rejection:syntax_error" },
      { ago: 0, area: "app", code: "uncaught:range_error", message: "bad index for <path>" },
    ]);
  });
});
