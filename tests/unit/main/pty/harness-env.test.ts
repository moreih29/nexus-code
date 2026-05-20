import { describe, expect, test } from "bun:test";
import { injectHarnessTerminalEnv } from "../../../../src/main/features/pty/harness-env";

describe("injectHarnessTerminalEnv", () => {
  test("undefined input → default ghostty values", () => {
    expect(injectHarnessTerminalEnv(undefined)).toEqual({
      TERM_PROGRAM: "ghostty",
      TERM_PROGRAM_VERSION: "1.0",
    });
  });

  test("empty object → default ghostty values", () => {
    expect(injectHarnessTerminalEnv({})).toEqual({
      TERM_PROGRAM: "ghostty",
      TERM_PROGRAM_VERSION: "1.0",
    });
  });

  test("caller-supplied TERM_PROGRAM is preserved, version injected", () => {
    expect(injectHarnessTerminalEnv({ TERM_PROGRAM: "iTerm.app" })).toEqual({
      TERM_PROGRAM: "iTerm.app",
      TERM_PROGRAM_VERSION: "1.0",
    });
  });

  test("caller-supplied TERM_PROGRAM_VERSION is preserved, program injected", () => {
    expect(injectHarnessTerminalEnv({ TERM_PROGRAM_VERSION: "2.0" })).toEqual({
      TERM_PROGRAM: "ghostty",
      TERM_PROGRAM_VERSION: "2.0",
    });
  });

  test("input object is not mutated", () => {
    const input: Record<string, string> = { OTHER: "value" };
    const original = { ...input };
    injectHarnessTerminalEnv(input);
    expect(input).toEqual(original);
  });
});
