import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { createNdjsonPipe } from "../../../../src/main/infra/agent/pipe";
import { AGENT_PROTOCOL_VERSION } from "../../../../src/shared/agent/envelope";

import { mainWarnMock } from "../../../../tests/log-test-spies";

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
    `${JSON.stringify({ type: "ready", protocolVersion: AGENT_PROTOCOL_VERSION, ...extra })}\n`,
    "utf8",
  );
}

function heartbeatFrame(seq: number, uptimeMs: number): Buffer {
  return Buffer.from(
    `${JSON.stringify({ event: "agent.heartbeat", payload: { seq, uptimeMs } })}\n`,
    "utf8",
  );
}

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
});

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
});

describe("createNdjsonPipe — heartbeat watchdog", () => {
  beforeEach(() => {
    mainWarnMock.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("emits a log.warn once when heartbeats are missed (3-miss window)", async () => {
    jest.useFakeTimers();
    try {
      const { stdout, pipe } = buildPipe();

      stdout.emitData(readyFrame({ heartbeatIntervalMs: 50 }));
      await pipe.ready;

      jest.advanceTimersByTime(160);

      expect(mainWarnMock).toHaveBeenCalledTimes(1);
      const [msg] = mainWarnMock.mock.calls[0] as [string];
      expect(msg).toContain("heartbeat watchdog");

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

      jest.advanceTimersByTime(150);
      expect(mainWarnMock).toHaveBeenCalledTimes(1);

      stdout.emitData(heartbeatFrame(1, 100));

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

      jest.advanceTimersByTime(1_000);

      expect(mainWarnMock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
