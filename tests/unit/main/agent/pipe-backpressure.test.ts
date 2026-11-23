import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createNdjsonPipe } from "../../../../src/main/infra/agent/pipe";
import { AGENT_PROTOCOL_VERSION } from "../../../../src/shared/agent/envelope";

class FakeReadable extends EventEmitter {
  pauseCount = 0;
  resumeCount = 0;
  paused = false;

  pause(): this {
    this.pauseCount++;
    this.paused = true;
    return this;
  }

  resume(): this {
    this.resumeCount++;
    this.paused = false;
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

function makeFrame(index: number, paddingSize = 0): Buffer {
  const padding = paddingSize > 0 ? "x".repeat(paddingSize) : undefined;
  const obj: Record<string, unknown> = { event: "test.frame", payload: { index } };
  if (padding !== undefined) obj.padding = padding;
  return Buffer.from(`${JSON.stringify(obj)}\n`, "utf8");
}

function makeReadyFrame(): Buffer {
  return Buffer.from(
    `${JSON.stringify({ type: "ready", protocolVersion: `${AGENT_PROTOCOL_VERSION}.0` })}\n`,
    "utf8",
  );
}

describe("pipe backpressure gate", () => {
  it("pauses stdout when cumulative line bytes exceed HWM during a burst", () => {
    const stdout = new FakeReadable();
    const stderr = new FakeReadable();
    const stdin = new FakeWritable();

    createNdjsonPipe({
      stdout: stdout as unknown as import("node:stream").Readable,
      stderr: stderr as unknown as import("node:stream").Readable,
      stdin: stdin as unknown as import("node:stream").Writable,
      classifyStderr: () => null,
      onTerminalError: () => {},
    });

    stdout.emitData(makeReadyFrame());

    const TOTAL_FRAMES = 1_100;
    for (let i = 0; i < TOTAL_FRAMES; i++) {
      stdout.emitData(makeFrame(i, 1_000));
    }

    expect(stdout.pauseCount).toBeGreaterThanOrEqual(1);
  });

  it("resumes stdout when tally is at or below LWM after a pause", () => {
    const stdout = new FakeReadable();
    const stderr = new FakeReadable();
    const stdin = new FakeWritable();

    createNdjsonPipe({
      stdout: stdout as unknown as import("node:stream").Readable,
      stderr: stderr as unknown as import("node:stream").Readable,
      stdin: stdin as unknown as import("node:stream").Writable,
      classifyStderr: () => null,
      onTerminalError: () => {},
    });

    stdout.emitData(makeReadyFrame());

    for (let i = 0; i < 1_100; i++) {
      stdout.emitData(makeFrame(i, 1_000));
    }
    expect(stdout.pauseCount).toBeGreaterThanOrEqual(1);

    stdout.emitData(makeFrame(9_999, 0));

    expect(stdout.resumeCount).toBeGreaterThanOrEqual(1);
    expect(stdout.pauseCount).toBe(stdout.resumeCount);
  });

  it("does not pause for a 20k small-frame burst whose total is below HWM", () => {
    const stdout = new FakeReadable();
    const stderr = new FakeReadable();
    const stdin = new FakeWritable();

    createNdjsonPipe({
      stdout: stdout as unknown as import("node:stream").Readable,
      stderr: stderr as unknown as import("node:stream").Readable,
      stdin: stdin as unknown as import("node:stream").Writable,
      classifyStderr: () => null,
      onTerminalError: () => {},
    });

    stdout.emitData(makeReadyFrame());

    for (let i = 0; i < 20_000; i++) {
      stdout.emitData(makeFrame(i, 0));
    }

    expect(stdout.pauseCount).toBe(0);
    expect(stdout.resumeCount).toBe(0);
  });

  it("pause and resume both fire during a 20k-frame burst that exceeds HWM", () => {
    const stdout = new FakeReadable();
    const stderr = new FakeReadable();
    const stdin = new FakeWritable();

    createNdjsonPipe({
      stdout: stdout as unknown as import("node:stream").Readable,
      stderr: stderr as unknown as import("node:stream").Readable,
      stdin: stdin as unknown as import("node:stream").Writable,
      classifyStderr: () => null,
      onTerminalError: () => {},
    });

    stdout.emitData(makeReadyFrame());

    const TOTAL_FRAMES = 20_000;
    for (let i = 0; i < TOTAL_FRAMES; i++) {
      stdout.emitData(makeFrame(i, 1_000));
    }

    expect(stdout.pauseCount).toBeGreaterThanOrEqual(1);
    expect(stdout.resumeCount).toBeGreaterThanOrEqual(1);

    expect(stdout.pauseCount - stdout.resumeCount).toBeLessThanOrEqual(1);
  });

  it("does not pause stdout when frame volume stays well below HWM", () => {
    const stdout = new FakeReadable();
    const stderr = new FakeReadable();
    const stdin = new FakeWritable();

    createNdjsonPipe({
      stdout: stdout as unknown as import("node:stream").Readable,
      stderr: stderr as unknown as import("node:stream").Readable,
      stdin: stdin as unknown as import("node:stream").Writable,
      classifyStderr: () => null,
      onTerminalError: () => {},
    });

    stdout.emitData(makeReadyFrame());

    for (let i = 0; i < 10; i++) {
      stdout.emitData(makeFrame(i, 0));
    }

    expect(stdout.pauseCount).toBe(0);
    expect(stdout.resumeCount).toBe(0);
  });

  it("stderr splitter does not affect stdout backpressure gate", () => {
    const stdout = new FakeReadable();
    const stderr = new FakeReadable();
    const stdin = new FakeWritable();

    createNdjsonPipe({
      stdout: stdout as unknown as import("node:stream").Readable,
      stderr: stderr as unknown as import("node:stream").Readable,
      stdin: stdin as unknown as import("node:stream").Writable,
      classifyStderr: () => null,
      onTerminalError: () => {},
    });

    stdout.emitData(makeReadyFrame());

    for (let i = 0; i < 2_000; i++) {
      stderr.emitData(Buffer.from(`stderr ${"x".repeat(1_000)}\n`, "utf8"));
    }

    expect(stdout.pauseCount).toBe(0);
    expect(stderr.pauseCount).toBe(0);
  });
});

function makeNamedFrame(event: string, index: number, paddingSize = 0): Buffer {
  const obj: Record<string, unknown> = { event, payload: { index } };
  if (paddingSize > 0) obj.padding = "x".repeat(paddingSize);
  return Buffer.from(`${JSON.stringify(obj)}\n`, "utf8");
}

describe("pipe backpressure gate — PassThrough (real stream, honors pause)", () => {
  it("delivers all frames when gate fires pause during async one-per-tick writes", (done) => {
    const stdout = new PassThrough({ highWaterMark: 64 * 1024 });
    const stderr = new PassThrough();
    const stdin = new FakeWritable();

    let ptyReceived = 0;
    let fsReceived = 0;

    const pipe = createNdjsonPipe({
      stdout,
      stderr,
      stdin: stdin as unknown as import("node:stream").Writable,
      classifyStderr: () => null,
      onTerminalError: (err) => done(err),
    });

    pipe.on("pty.data", () => ptyReceived++);
    pipe.on("fs.changed", () => fsReceived++);

    const PTY_FRAMES = 1_100;
    const FS_FRAMES = 5;

    let i = 0;
    function writeNext() {
      if (i === 0) {
        stdout.write(makeReadyFrame());
      } else if (i <= PTY_FRAMES) {
        stdout.write(makeNamedFrame("pty.data", i - 1, 1_000));
      } else if (i <= PTY_FRAMES + FS_FRAMES) {
        stdout.write(makeNamedFrame("fs.changed", i - PTY_FRAMES - 1));
      } else {
        setTimeout(() => {
          try {
            expect(stdout.isPaused()).toBe(false);
            expect(ptyReceived).toBe(PTY_FRAMES);
            expect(fsReceived).toBe(FS_FRAMES);
            done();
          } catch (err) {
            done(err);
          }
        }, 200);
        return;
      }
      i++;
      setImmediate(writeNext);
    }
    setImmediate(writeNext);
  }, 10_000);

  it("delivers all frames when all data arrives in one PassThrough write (batch scenario)", (done) => {
    const stdout = new PassThrough({ highWaterMark: 4 * 1024 * 1024 });
    const stderr = new PassThrough();
    const stdin = new FakeWritable();

    let ptyReceived = 0;
    let fsReceived = 0;

    const pipe = createNdjsonPipe({
      stdout,
      stderr,
      stdin: stdin as unknown as import("node:stream").Writable,
      classifyStderr: () => null,
      onTerminalError: (err) => done(err),
    });

    pipe.on("pty.data", () => ptyReceived++);
    pipe.on("fs.changed", () => fsReceived++);

    const PTY_FRAMES = 1_100;
    const FS_FRAMES = 20;

    const chunks: Buffer[] = [makeReadyFrame()];
    for (let i = 0; i < PTY_FRAMES; i++) chunks.push(makeNamedFrame("pty.data", i, 1_000));
    for (let i = 0; i < FS_FRAMES; i++) chunks.push(makeNamedFrame("fs.changed", i));

    stdout.write(Buffer.concat(chunks));
    stdout.end();

    stdout.on("end", () => {
      setImmediate(() => {
        try {
          expect(ptyReceived).toBe(PTY_FRAMES);
          expect(fsReceived).toBe(FS_FRAMES);
          expect(stdout.isPaused()).toBe(false);
          done();
        } catch (err) {
          done(err);
        }
      });
    });
    stdout.on("error", (err) => done(err));
  }, 10_000);
});
