/**
 * Unit tests for the ready-frame extended fields and heartbeat processing
 * added to createNdjsonPipe (pipe.ts T2).
 *
 * Three cases:
 *   1. Ready frame with methods + heartbeatIntervalMs populates pipe capabilities.
 *   2. Heartbeat event is routed to external on() subscribers unchanged.
 *   3. Heartbeat watchdog emits a log.warn once when heartbeats are missed,
 *      resets after a heartbeat is received, and stops after dispose().
 */
import { AGENT_PROTOCOL_VERSION } from "../../../../src/shared/agent/envelope";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { createNdjsonPipe } from "../../../../src/main/infra/agent/pipe";

// Spy imported from the preload — the log-test-spies.ts preload wraps
// src/shared/log/main's createLogger so that every call to log.warn()
// inside pipe.ts (via getMalformedStdoutLogger()) increments mainWarnMock,
// regardless of which earlier test file first called getMalformedStdoutLogger().
import { mainWarnMock } from "../../../../tests/log-test-spies";

// ---------------------------------------------------------------------------
// Minimal fake stream helpers (mirrors the pattern from pipe-void-response.test.ts)
// ---------------------------------------------------------------------------

class FakeReadable extends EventEmitter {
  pause(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  emitData(chunk: Buffer): void {
    this.emit("data", chunk);
  }
}

class FakeWritable {
  readonly writes: string[] = [];
  writable = true;
  destroyed = false;

  write(line: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(line);
    callback?.();
    return true;
  }
}

// ---------------------------------------------------------------------------
// Frame factories
// ---------------------------------------------------------------------------

function readyFrame(extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({ type: "ready", protocolVersion: AGENT_PROTOCOL_VERSION, ...extra }) + "\n",
    "utf8",
  );
}

function heartbeatFrame(seq: number, uptimeMs: number): Buffer {
  return Buffer.from(
    JSON.stringify({ event: "agent.heartbeat", payload: { seq, uptimeMs } }) + "\n",
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Helper: build a pipe with injectable stdout / stderr / stdin
// ---------------------------------------------------------------------------

function buildPipe(stdoutOverride?: FakeReadable) {
  const stdout = stdoutOverride ?? new FakeReadable();
  const stderr = new FakeReadable();
  const stdin = new FakeWritable();
  const pipe = createNdjsonPipe({
    stdout: stdout as unknown as Readable,
    stderr: stderr as unknown as Readable,
    stdin: stdin as unknown as Writable,
    classifyStderr: () => null,
    onTerminalError: () => {},
  });
  return { stdout, stderr, stdin, pipe };
}

// ---------------------------------------------------------------------------
// Case 1 — Ready frame extended fields
// ---------------------------------------------------------------------------

describe("createNdjsonPipe — ready frame extended fields", () => {
  it("exposes methods and heartbeatIntervalMs after the ready frame arrives", async () => {
    const { stdout, pipe } = buildPipe();

    stdout.emitData(
      readyFrame({
        methods: ["fs.readdir", "hook.getInfo"],
        heartbeatIntervalMs: 10_000,
      }),
    );

    await pipe.ready;

    expect(pipe.methods).toEqual(["fs.readdir", "hook.getInfo"]);
    expect(pipe.heartbeatIntervalMs).toBe(10_000);

    pipe.dispose();
  });

  it("leaves methods and heartbeatIntervalMs undefined when the ready frame omits them", async () => {
    const { stdout, pipe } = buildPipe();

    // Plain ready frame — no extended fields.
    stdout.emitData(readyFrame());
    await pipe.ready;

    expect(pipe.methods).toBeUndefined();
    expect(pipe.heartbeatIntervalMs).toBeUndefined();

    pipe.dispose();
  });
});

// ---------------------------------------------------------------------------
// Case 2 — Heartbeat event routing
// ---------------------------------------------------------------------------

describe("createNdjsonPipe — heartbeat event routing", () => {
  it("delivers agent.heartbeat payload to on() subscribers", async () => {
    const { stdout, pipe } = buildPipe();

    stdout.emitData(readyFrame({ heartbeatIntervalMs: 10_000 }));
    await pipe.ready;

    const received: unknown[] = [];
    pipe.on("agent.heartbeat", (payload) => {
      received.push(payload);
    });

    stdout.emitData(heartbeatFrame(1, 100));
    stdout.emitData(heartbeatFrame(2, 200));

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ seq: 1, uptimeMs: 100 });
    expect(received[1]).toEqual({ seq: 2, uptimeMs: 200 });

    pipe.dispose();
  });

  it("supports multiple independent on() subscribers for agent.heartbeat", async () => {
    const { stdout, pipe } = buildPipe();

    stdout.emitData(readyFrame());
    await pipe.ready;

    const callsA: unknown[] = [];
    const callsB: unknown[] = [];
    pipe.on("agent.heartbeat", (p) => callsA.push(p));
    pipe.on("agent.heartbeat", (p) => callsB.push(p));

    stdout.emitData(heartbeatFrame(3, 300));

    expect(callsA).toHaveLength(1);
    expect(callsB).toHaveLength(1);

    pipe.dispose();
  });
});

// ---------------------------------------------------------------------------
// Case 3 — Heartbeat watchdog warns once, resets, stops after dispose
// ---------------------------------------------------------------------------

describe("createNdjsonPipe — heartbeat watchdog", () => {
  beforeEach(() => {
    // Clear accumulated warn calls from prior tests (e.g. createSshError calls
    // from pipe-protocol-version.test.ts) so only the watchdog's warn in this
    // test is counted.
    mainWarnMock.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("emits a log.warn once when heartbeats are missed (3-miss window)", async () => {
    jest.useFakeTimers();
    try {
      const { stdout, pipe } = buildPipe();

      // heartbeatIntervalMs=50ms → watchdog fires at 150ms.
      stdout.emitData(readyFrame({ heartbeatIntervalMs: 50 }));
      await pipe.ready;

      // No heartbeats sent. Advance past the 3-miss window.
      jest.advanceTimersByTime(160);

      expect(mainWarnMock).toHaveBeenCalledTimes(1);
      // The preload wrapper calls warn(msg, meta?) — first arg is the message.
      const [msg] = mainWarnMock.mock.calls[0] as [string];
      expect(msg).toContain("heartbeat watchdog");

      // Advancing further must NOT produce a second warning (heartbeatWarned guard).
      jest.advanceTimersByTime(160);
      expect(mainWarnMock).toHaveBeenCalledTimes(1);

      pipe.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it("resets the warned flag when a heartbeat arrives after a missed window", async () => {
    jest.useFakeTimers();
    try {
      const { stdout, pipe } = buildPipe();

      stdout.emitData(readyFrame({ heartbeatIntervalMs: 50 }));
      await pipe.ready;

      // Advance exactly to the watchdog boundary (150ms = 50*3) — first warn fires.
      jest.advanceTimersByTime(150);
      expect(mainWarnMock).toHaveBeenCalledTimes(1);

      // Heartbeat arrives now (at t=150), resetting lastHeartbeatAt to t=150 and
      // clearing the heartbeatWarned flag.
      stdout.emitData(heartbeatFrame(1, 100));

      // Advance another 150ms — the watchdog fires at t=300.
      // diff = 300 - 150 = 150 >= 150 → second warn fires.
      jest.advanceTimersByTime(150);
      expect(mainWarnMock).toHaveBeenCalledTimes(2);

      pipe.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it("stops the watchdog after dispose() — no further warnings", async () => {
    jest.useFakeTimers();
    try {
      const { stdout, pipe } = buildPipe();

      stdout.emitData(readyFrame({ heartbeatIntervalMs: 50 }));
      await pipe.ready;

      pipe.dispose();

      // Advance well past the watchdog window — nothing should fire.
      jest.advanceTimersByTime(1_000);

      expect(mainWarnMock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
