/**
 * Unit tests for the logging facade types and NxLogMeta envelope.
 *
 * Tests cover the structural contracts that downstream consumers (file
 * transport format, Go-forwarding relay) depend on.  They do NOT re-test
 * electron-log's own transport machinery.
 */

import { describe, expect, test } from "bun:test";
import type { Logger, LogMeta, LogSource, NxLogMeta } from "../../../../src/shared/log/types";

// ---------------------------------------------------------------------------
// NxLogMeta envelope
// ---------------------------------------------------------------------------

describe("NxLogMeta envelope", () => {
  test("sentinel field is always true", () => {
    const meta: NxLogMeta = { __nx_log: true, source: "main" };
    expect(meta.__nx_log).toBe(true);
  });

  test("accepts all valid LogSource values", () => {
    const sources: LogSource[] = ["main", "renderer", "agent"];
    for (const source of sources) {
      const meta: NxLogMeta = { __nx_log: true, source };
      expect(meta.source).toBe(source);
    }
  });

  test("accepts arbitrary string source for Go-forwarding path", () => {
    const meta: NxLogMeta = { __nx_log: true, source: "go-agent-custom" };
    expect(meta.source).toBe("go-agent-custom");
  });

  test("correlationId is optional and carried through when present", () => {
    const withId: NxLogMeta = { __nx_log: true, source: "main", correlationId: "req-abc" };
    const withoutId: NxLogMeta = { __nx_log: true, source: "main" };

    expect(withId.correlationId).toBe("req-abc");
    expect(withoutId.correlationId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LogMeta
// ---------------------------------------------------------------------------

describe("LogMeta", () => {
  test("correlationId is optional", () => {
    const empty: LogMeta = {};
    const withId: LogMeta = { correlationId: "x" };

    expect(empty.correlationId).toBeUndefined();
    expect(withId.correlationId).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// Logger interface shape (compile-time contract exercised at runtime)
// ---------------------------------------------------------------------------

describe("Logger interface", () => {
  test("all four log-level methods exist on a conforming object", () => {
    // Create a minimal no-op Logger to verify the interface is stable
    const logger: Logger = {
      error: (_msg: string, _meta?: LogMeta) => {},
      warn: (_msg: string, _meta?: LogMeta) => {},
      info: (_msg: string, _meta?: LogMeta) => {},
      debug: (_msg: string, _meta?: LogMeta) => {},
    };

    expect(typeof logger.error).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// File-transport format logic (extracted and tested as a pure function)
// ---------------------------------------------------------------------------

describe("file-transport JSON format", () => {
  /**
   * Replicates the format function from main.ts so we can unit-test the
   * JSON serialization without importing electron-log or Electron.
   */
  function formatToJsonLine(
    level: string,
    date: Date,
    data: unknown[],
    processType = "main",
  ): string {
    const [head, ...rest] = data;

    let source: string = processType;
    let correlationId: string | undefined;
    let msgParts: unknown[] = [head, ...rest];

    if (
      head !== null &&
      typeof head === "object" &&
      (head as Record<string, unknown>).__nx_log === true
    ) {
      const env = head as NxLogMeta;
      source = env.source;
      correlationId = env.correlationId;
      msgParts = rest;
    }

    const entry: Record<string, unknown> = {
      ts: date.toISOString(),
      level,
      source,
      msg: msgParts.length === 1 && typeof msgParts[0] === "string" ? msgParts[0] : msgParts,
    };

    if (correlationId !== undefined) {
      entry.correlationId = correlationId;
    }

    return JSON.stringify(entry);
  }

  const fixedDate = new Date("2026-01-01T00:00:00.000Z");

  test("plain log call without envelope uses processType as source", () => {
    const line = formatToJsonLine("info", fixedDate, ["hello"], "main");
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed.level).toBe("info");
    expect(parsed.source).toBe("main");
    expect(parsed.msg).toBe("hello");
    expect(parsed.ts).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed.correlationId).toBeUndefined();
  });

  test("envelope with source overrides processType", () => {
    const envelope: NxLogMeta = { __nx_log: true, source: "renderer" };
    const line = formatToJsonLine("warn", fixedDate, [envelope, "renderer message"]);
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed.source).toBe("renderer");
    expect(parsed.msg).toBe("renderer message");
    expect(parsed.correlationId).toBeUndefined();
  });

  test("correlationId is included in JSON when present", () => {
    const envelope: NxLogMeta = { __nx_log: true, source: "agent", correlationId: "req-42" };
    const line = formatToJsonLine("error", fixedDate, [envelope, "agent crashed"]);
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed.source).toBe("agent");
    expect(parsed.correlationId).toBe("req-42");
    expect(parsed.msg).toBe("agent crashed");
  });

  test("multiple message parts are kept as array in msg field", () => {
    const envelope: NxLogMeta = { __nx_log: true, source: "main" };
    const line = formatToJsonLine("debug", fixedDate, [envelope, "part1", { key: "val" }]);
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(Array.isArray(parsed.msg)).toBe(true);
    expect((parsed.msg as unknown[])[0]).toBe("part1");
    expect((parsed.msg as unknown[])[1]).toEqual({ key: "val" });
  });

  test("arbitrary string source passes through for Go-forwarding path", () => {
    const envelope: NxLogMeta = { __nx_log: true, source: "go-subprocess" };
    const line = formatToJsonLine("info", fixedDate, [envelope, "go log line"]);
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed.source).toBe("go-subprocess");
  });

  test("output is valid JSON (parseable)", () => {
    const envelope: NxLogMeta = { __nx_log: true, source: "main" };
    expect(() => JSON.parse(formatToJsonLine("info", fixedDate, [envelope, "msg"]))).not.toThrow();
  });
});
