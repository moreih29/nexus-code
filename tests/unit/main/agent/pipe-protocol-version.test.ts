import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { createNdjsonPipe } from "../../../../src/main/infra/agent/pipe";
import { AGENT_PROTOCOL_VERSION } from "../../../../src/shared/agent/envelope";

const MAJOR = AGENT_PROTOCOL_VERSION.split(".", 1)[0];
const OTHER_MAJOR = String(Number(MAJOR) + 1);

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

function buildPipe(extraOptions: { expectedProtocolMajor?: string } = {}): {
  stdout: FakeReadable;
  pipe: ReturnType<typeof createNdjsonPipe>;
  getTerminalError: () => Error | null;
} {
  const stdout = new FakeReadable();
  const stderr = new FakeReadable();
  const stdin = new FakeWritable();
  let terminalError: Error | null = null;

  const pipe = createNdjsonPipe({
    stdout: stdout as unknown as Readable,
    stderr: stderr as unknown as Readable,
    stdin: stdin as unknown as Writable,
    classifyStderr: () => null,
    onTerminalError: (err) => {
      terminalError = err;
    },
    ...extraOptions,
  });

  return {
    stdout,
    pipe,
    getTerminalError: () => terminalError,
  };
}

function readyFrameWith(protocolVersion: string | undefined): Buffer {
  const obj: Record<string, unknown> = { type: "ready" };
  if (protocolVersion !== undefined) {
    obj.protocolVersion = protocolVersion;
  }
  return Buffer.from(`${JSON.stringify(obj)}\n`, "utf8");
}

describe("createNdjsonPipe — protocolVersion validation", () => {
  test("Case E: protocolVersion `MAJOR.0` → ready resolves, no terminal error", async () => {
    const { stdout, pipe, getTerminalError } = buildPipe();

    stdout.emitData(readyFrameWith(`${MAJOR}.0`));
    await pipe.ready;

    expect(getTerminalError()).toBeNull();
    pipe.dispose();
  });

  test('Case F: protocolVersion `OTHER.0` → terminal error "server.protocol-version-mismatch"', async () => {
    const { stdout, pipe, getTerminalError } = buildPipe();

    stdout.emitData(readyFrameWith(`${OTHER_MAJOR}.0`));

    await expect(pipe.ready).rejects.toMatchObject({
      code: "server.protocol-version-mismatch",
    });

    const err = getTerminalError() as unknown as { code: string } | null;
    expect(err).not.toBeNull();
    expect(err?.code).toBe("server.protocol-version-mismatch");
  });

  test("Case G: protocolVersion `MAJOR.5` → ready resolves (major-only match)", async () => {
    const { stdout, pipe, getTerminalError } = buildPipe();

    stdout.emitData(readyFrameWith(`${MAJOR}.5`));
    await pipe.ready;

    expect(getTerminalError()).toBeNull();
    pipe.dispose();
  });

  test("Case H: protocolVersion undefined → ready resolves (backward-compat pass)", async () => {
    const { stdout, pipe, getTerminalError } = buildPipe();

    stdout.emitData(readyFrameWith(undefined));
    await pipe.ready;

    expect(getTerminalError()).toBeNull();
    pipe.dispose();
  });

  test('Case I: protocolVersion "" → terminal error "server.protocol-version-mismatch"', async () => {
    const { stdout, pipe, getTerminalError } = buildPipe();

    stdout.emitData(readyFrameWith(""));

    await expect(pipe.ready).rejects.toMatchObject({
      code: "server.protocol-version-mismatch",
    });

    const err = getTerminalError() as unknown as { code: string } | null;
    expect(err).not.toBeNull();
    expect(err?.code).toBe("server.protocol-version-mismatch");
  });
});
