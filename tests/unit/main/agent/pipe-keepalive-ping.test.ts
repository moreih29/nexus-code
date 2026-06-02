/**
 * Unit tests for the client keepalive ping (pipe.ts).
 *
 * Contract: the client pings the agent ONLY when the ready frame advertises a
 * positive idleWatchdogMs (SSH agents; 0/absent for local), and it pings every
 * idleWatchdogMs / KEEPALIVE_PING_SLOTS so a live-but-idle session keeps the
 * agent's idle watchdog from tripping. Gating is keyed on idleWatchdogMs, NOT
 * heartbeatIntervalMs — a local agent advertises heartbeat but no watchdog, and
 * must receive no pings.
 *
 *   1. idleWatchdogMs > 0 → pings fire at idleWatchdogMs / 6.
 *   2. idleWatchdogMs absent (heartbeat-only) → no pings ever.
 *   3. pings stop after dispose().
 */
import { afterEach, describe, expect, it, jest } from "bun:test";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { createNdjsonPipe } from "../../../../src/main/infra/agent/pipe";

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

function readyFrame(extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    `${JSON.stringify({ type: "ready", protocolVersion: "1", ...extra })}\n`,
    "utf8",
  );
}

function buildPipe() {
  const stdout = new FakeReadable();
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

function pingCount(stdin: FakeWritable): number {
  return stdin.writes.filter((line) => line.includes('"method":"ping"')).length;
}

describe("createNdjsonPipe — keepalive ping", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("pings at idleWatchdogMs / 6 when the agent advertises a watchdog", async () => {
    jest.useFakeTimers();
    try {
      const { stdout, stdin, pipe } = buildPipe();

      // idleWatchdogMs=60 → ping interval = floor(60/6) = 10ms.
      stdout.emitData(readyFrame({ heartbeatIntervalMs: 50, idleWatchdogMs: 60 }));
      await pipe.ready;

      jest.advanceTimersByTime(35); // ticks at 10, 20, 30
      expect(pingCount(stdin)).toBe(3);

      pipe.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it("never pings when the ready frame omits idleWatchdogMs (local agent)", async () => {
    jest.useFakeTimers();
    try {
      const { stdout, stdin, pipe } = buildPipe();

      // Heartbeat enabled but no watchdog advertised — gating is on the watchdog.
      stdout.emitData(readyFrame({ heartbeatIntervalMs: 50 }));
      await pipe.ready;

      jest.advanceTimersByTime(1_000);
      expect(pingCount(stdin)).toBe(0);

      pipe.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it("stops pinging after dispose()", async () => {
    jest.useFakeTimers();
    try {
      const { stdout, stdin, pipe } = buildPipe();

      stdout.emitData(readyFrame({ idleWatchdogMs: 60 }));
      await pipe.ready;

      jest.advanceTimersByTime(25); // ticks at 10, 20
      const before = pingCount(stdin);
      expect(before).toBeGreaterThan(0);

      pipe.dispose();
      jest.advanceTimersByTime(1_000);
      expect(pingCount(stdin)).toBe(before);
    } finally {
      jest.useRealTimers();
    }
  });
});
