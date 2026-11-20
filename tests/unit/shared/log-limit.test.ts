import { describe, expect, mock, test } from "bun:test";
import {
  extOf,
  limitLog,
  safeText,
  shortId,
  stripPaths,
  truncate,
} from "../../../src/shared/log/limit";
import { redactLogSecrets } from "../../../src/shared/log/redact-secrets";

function fake() {
  const warn = mock();
  return {
    warn,
    logger: { error: mock(), warn, info: mock(), debug: mock() },
  };
}

describe("limitLog", () => {
  test("same key inside the interval writes once", () => {
    const { warn, logger } = fake();
    let t = 0;
    const lim = limitLog(logger, { intervalMs: 1000, now: () => t });
    lim.log("warn", "a", "x");
    t = 999;
    lim.log("warn", "a", "x");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("next line after the interval carries the held-back count", () => {
    const { warn, logger } = fake();
    let t = 0;
    const lim = limitLog(logger, { intervalMs: 1000, now: () => t });
    lim.log("warn", "a", "x");
    lim.log("warn", "a", "x");
    lim.log("warn", "a", "x");
    t = 1000;
    lim.log("warn", "a", "x");
    expect(warn.mock.calls[1]?.[0]).toBe("x (2 more)");
    t = 2000;
    lim.log("warn", "a", "x");
    expect(warn.mock.calls[2]?.[0]).toBe("x");
  });

  test("different keys do not suppress each other", () => {
    const { warn, logger } = fake();
    const lim = limitLog(logger, { intervalMs: 1000, now: () => 0 });
    lim.log("warn", "a", "x");
    lim.log("warn", "b", "y");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("key map stays under the cap", () => {
    const { warn, logger } = fake();
    const lim = limitLog(logger, { intervalMs: 1_000_000, maxKeys: 3, now: () => 0 });
    for (let i = 0; i < 10; i++) lim.log("warn", `k${i}`, "x");
    expect(warn).toHaveBeenCalledTimes(10);
    // k0 was dropped to make room, so it writes again instead of being held back.
    lim.log("warn", "k0", "x");
    expect(warn).toHaveBeenCalledTimes(11);
    // k9 is still tracked.
    lim.log("warn", "k9", "x");
    expect(warn).toHaveBeenCalledTimes(11);
  });
});

describe("text helpers", () => {
  test("shortId keeps 8 characters", () => {
    expect(shortId("0123456789abcdef")).toBe("01234567");
    expect(shortId("abc")).toBe("abc");
  });

  test("truncate", () => {
    expect(truncate("abcdef", 6)).toBe("abcdef");
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 0)).toBe("");
  });

  test("stripPaths removes posix, windows, unc and home paths", () => {
    expect(stripPaths("ENOENT: open /Users/me/work/a.ts failed")).toBe(
      "ENOENT: open <path> failed",
    );
    expect(stripPaths("bad C:\\Users\\me\\x.txt here")).toBe("bad <path> here");
    expect(stripPaths("at \\\\server\\share\\dir\\f")).toBe("at <path>");
    expect(stripPaths("in ~/proj/x")).toBe("in <path>");
    expect(stripPaths("no path here")).toBe("no path here");
  });

  test("extOf returns only the extension", () => {
    expect(extOf("/a/b/c.test.ts")).toBe(".ts");
    expect(extOf("/a/b/Makefile")).toBe("");
    expect(extOf("/a/.env")).toBe("");
  });

  test("safeText redacts, strips paths, folds lines and cuts", () => {
    const out = safeText("fail /home/u/x token=abc123\nnext", 200, redactLogSecrets);
    expect(out).toBe("fail <path> token=[redacted] next");
    expect(safeText("x".repeat(500), 200).length).toBe(200);
  });
});
