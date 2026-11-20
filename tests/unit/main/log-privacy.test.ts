import { describe, expect, test } from "bun:test";
import {
  isTeardownFailure,
  reportWatchFailure,
} from "../../../src/main/features/fs/bridge/watch-failure-log";
import { describeError, FAULT_MESSAGE_MAX } from "../../../src/main/infra/error-safety-net";
import { limitLog } from "../../../src/shared/log/limit";

const WORKSPACE = "0f3c9a1e-7b2d-4c58-9d10-aaaaaaaaaaaa";

function sinks() {
  const calls: { level: string; msg: string }[] = [];
  const mk = (level: string) => (msg: string) => void calls.push({ level, msg });
  const logger = { error: mk("error"), warn: mk("warn"), info: mk("info"), debug: mk("debug") };
  return { calls, limited: limitLog(logger) };
}

describe("watch failure lines", () => {
  test("carry a short workspace id and no path, full id or file name", () => {
    const { calls, limited } = sinks();
    reportWatchFailure(
      limited,
      "git.watch replay",
      WORKSPACE,
      new Error("open /Users/me/secret-project/.git/HEAD: permission denied"),
    );
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.level).toBe("warn");
    expect(call?.msg).toBe(
      "git.watch replay failed (workspace=0f3c9a1e): open <path>: permission denied",
    );
    expect(call?.msg).not.toContain(WORKSPACE);
    expect(call?.msg).not.toContain("secret-project");
  });

  test("a failure of a connection that was going away is a debug line", () => {
    const { calls, limited } = sinks();
    reportWatchFailure(limited, "fs.unwatch cleanup", WORKSPACE, new Error("SSH channel disposed"));
    expect(calls[0]?.level).toBe("debug");
    expect(isTeardownFailure(new Error("boom"))).toBe(false);
    expect(isTeardownFailure(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
  });

  test("repeats for one workspace are limited", () => {
    const { calls, limited } = sinks();
    for (let i = 0; i < 5; i++)
      reportWatchFailure(limited, "fs.unwatch cleanup", WORKSPACE, new Error("boom"));
    expect(calls).toHaveLength(1);
  });
});

describe("fault lines", () => {
  test("a long message is cut and the stack frames stay", () => {
    const error = new Error("x".repeat(5000));
    const text = describeError(error);
    expect(text.length).toBeLessThan(FAULT_MESSAGE_MAX + 2000);
    expect(text.startsWith(`Error: ${"x".repeat(FAULT_MESSAGE_MAX - 1)}…`)).toBe(true);
    expect(text).toContain("\n    at ");
    expect(describeError("y".repeat(900)).length).toBe(FAULT_MESSAGE_MAX);
  });
});
