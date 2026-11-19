/**
 * Event listeners run synchronously inside the stdout data handler. One that
 * throws must not take the rest of the chunk, or the other subscribers, down
 * with it, and one that unsubscribes must stop receiving events.
 */
import { describe, expect, it, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { createNdjsonPipe, createSshError } from "../../../../src/main/infra/agent/pipe";
import { AGENT_PROTOCOL_VERSION } from "../../../../src/shared/agent/envelope";
import { mainWarnMock } from "../../../log-test-spies";

class FakeReadable extends EventEmitter {
  pauseCount = 0;

  pause(): this {
    this.pauseCount++;
    return this;
  }
  resume(): this {
    return this;
  }
}

class FakeWritable {
  writable = true;
  destroyed = false;

  write(_line: string, callback?: (error?: Error | null) => void): boolean {
    callback?.();
    return true;
  }
}

describe("NDJSON pipe event listeners", () => {
  it("keeps delivering events when one listener throws", () => {
    const stdout = new FakeReadable();
    let terminalError: Error | null = null;
    const pipe = createNdjsonPipe({
      stdout: stdout as unknown as Readable,
      stderr: new FakeReadable() as unknown as Readable,
      stdin: new FakeWritable() as unknown as Writable,
      classifyStderr: () => null,
      onTerminalError: (error) => {
        terminalError = error;
      },
    });
    const received: number[] = [];
    pipe.on("fs.changed", () => {
      throw new Error("listener bug");
    });
    pipe.on("fs.changed", (payload) => received.push((payload as { index: number }).index));

    const lines = [
      { type: "ready", protocolVersion: `${AGENT_PROTOCOL_VERSION}.0` },
      { event: "fs.changed", payload: { index: 1 } },
      { event: "fs.changed", payload: { index: 2 } },
    ];
    const chunk = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
    expect(() => stdout.emit("data", Buffer.from(chunk))).not.toThrow();

    expect(received).toEqual([1, 2]);
    expect(terminalError).toBeNull();
    pipe.dispose();
  });

  it("unsubscribed listener does not receive frames delivered after a pause cycle", () => {
    const stdout = new FakeReadable();
    const pipe = createNdjsonPipe({
      stdout: stdout as unknown as Readable,
      stderr: new FakeReadable() as unknown as Readable,
      stdin: new FakeWritable() as unknown as Writable,
      classifyStderr: () => null,
      onTerminalError: () => {},
    });
    let callCountBefore = 0;
    let callCountAfter = 0;
    const unsubscribe = pipe.on("fs.changed", () => {
      callCountBefore++;
    });

    const frame = (line: object) => Buffer.from(`${JSON.stringify(line)}\n`);
    stdout.emit("data", frame({ type: "ready", protocolVersion: `${AGENT_PROTOCOL_VERSION}.0` }));

    // 1,100 frames of ~1 KB cross the 1 MB high-water mark and pause stdout.
    for (let i = 0; i < 1_100; i++) {
      stdout.emit(
        "data",
        frame({ event: "pty.data", payload: { index: i }, padding: "x".repeat(1_000) }),
      );
    }
    expect(stdout.pauseCount).toBeGreaterThanOrEqual(1);

    // Unsubscribe before the post-resume frames arrive, then subscribe anew.
    unsubscribe();
    pipe.on("fs.changed", () => {
      callCountAfter++;
    });

    for (let i = 0; i < 10; i++) {
      stdout.emit("data", frame({ event: "fs.changed", payload: { index: i } }));
    }

    expect(callCountBefore).toBe(0);
    expect(callCountAfter).toBe(10);
    pipe.dispose();
  });
});

test("agent diagnostics mask credentials before generating a preview", async () => {
  const start = mainWarnMock.mock.calls.length;
  const detail = "fetch https://user-fixture:password-fixture@example.test?token=query-fixture&v=2";
  const error = createSshError("server.spawn-failed", new Error(detail));
  expect(error.cause).toMatchObject({ message: detail });

  const stdout = new PassThrough();
  const pipe = createNdjsonPipe({
    stdout,
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    classifyStderr: () => null,
    onTerminalError: () => {},
  });
  const ready = pipe.ready.catch((failure: unknown) => failure);
  stdout.write(
    `login https://${"x".repeat(256)}long-credential@example.test Authorization: Bearer bearer-fixture APP_SECRET="quoted fixture"\n`,
  );
  expect(await ready).toMatchObject({ code: "server.protocol-error" });
  const messages = mainWarnMock.mock.calls
    .slice(start)
    .map(([message]) => message)
    .join("\n");
  expect(messages).toContain("stdout NDJSON parse failed");
  expect(messages).toContain("example.test");
  for (const secret of [
    "user-fixture",
    "password-fixture",
    "query-fixture",
    "x".repeat(30),
    "bearer-fixture",
    "quoted fixture",
  ]) {
    expect(messages).not.toContain(secret);
  }
  pipe.dispose();
});
