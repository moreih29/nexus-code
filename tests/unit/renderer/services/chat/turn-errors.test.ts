import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ResultInfo } from "../../../../../src/renderer/services/chat/model";
import { reportTurnError } from "../../../../../src/renderer/services/chat/turn-errors";

const calls: unknown[][] = [];
const previous = (globalThis as Record<string, unknown>).window;

beforeEach(() => {
  calls.length = 0;
  (globalThis as Record<string, unknown>).window = {
    ipc: {
      call: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(null);
      },
    },
  };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).window = previous;
});

const result = (over: Partial<ResultInfo>): ResultInfo => ({
  subtype: "success",
  isError: false,
  ...over,
});

describe("a turn that ended", () => {
  test("in an API failure is recorded by agent, kind and status, never its words", () => {
    reportTurnError(
      "claude",
      result({
        isError: true,
        outcome: "error",
        error: "the user's prompt was too long",
        failure: { kind: "transient", status: 529 },
      }),
    );
    reportTurnError(
      "codex",
      result({ subtype: "failed", isError: true, failure: { kind: "request", status: 400 } }),
    );
    reportTurnError("codex", result({ subtype: "failed", isError: true }));
    expect(calls).toEqual([
      ["system", "recordError", { area: "agent", code: "claude:transient", status: 529 }],
      ["system", "recordError", { area: "agent", code: "codex:request", status: 400 }],
      ["system", "recordError", { area: "agent", code: "codex:failed" }],
    ]);
    expect(JSON.stringify(calls)).not.toContain("prompt");
  });

  test("well, or stopped by the user, records nothing", () => {
    reportTurnError("claude", result({ outcome: "success" }));
    reportTurnError("claude", result({ isError: true, outcome: "interrupted" }));
    reportTurnError("codex", result({ subtype: "interrupted" }));
    reportTurnError("codex", undefined);
    expect(calls).toEqual([]);
  });
});
