import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { createNdjsonPipe } from "../../../../src/main/infra/agent/pipe";
import { AGENT_PROTOCOL_VERSION } from "../../../../src/shared/agent/envelope";

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

function makeReadyFrame(): Buffer {
  return Buffer.from(
    `${JSON.stringify({ type: "ready", protocolVersion: `${AGENT_PROTOCOL_VERSION}.0` })}\n`,
    "utf8",
  );
}

function frame(line: string): Buffer {
  return Buffer.from(`${line}\n`, "utf8");
}

function buildPipe() {
  const stdout = new FakeReadable();
  const stderr = new FakeReadable();
  const stdin = new FakeWritable();
  let terminalError: Error | null = null;
  const pipe = createNdjsonPipe({
    stdout: stdout as unknown as Readable,
    stderr: stderr as unknown as Readable,
    stdin: stdin as unknown as Writable,
    classifyStderr: () => null,
    onTerminalError: (error) => {
      terminalError = error;
    },
  });
  stdout.emitData(makeReadyFrame());
  return {
    stdout,
    stdin,
    pipe,
    get terminalError(): Error | null {
      return terminalError;
    },
  };
}

describe("createNdjsonPipe void-response shim", () => {
  it('resolves a pending request when the agent emits `{"id":"x"}` with no result/error/event', async () => {
    const { stdout, pipe, stdin } = buildPipe();

    const result = pipe.call("void.method");

    expect(stdin.writes).toHaveLength(1);
    const requestId = (JSON.parse(stdin.writes[0]!) as { id: string }).id;

    stdout.emitData(frame(JSON.stringify({ id: requestId })));

    await expect(result).resolves.toBeNull();
  });

  it("still resolves when the agent emits the explicit `result: null` form", async () => {
    const { stdout, pipe, stdin } = buildPipe();

    const result = pipe.call("void.method");
    const requestId = (JSON.parse(stdin.writes[0]!) as { id: string }).id;

    stdout.emitData(frame(JSON.stringify({ id: requestId, result: null })));

    await expect(result).resolves.toBeNull();
  });

  it("does not crash the channel when the bare-id frame arrives", async () => {
    const { stdout, pipe, stdin } = buildPipe();
    const result = pipe.call("void.method");
    const requestId = (JSON.parse(stdin.writes[0]!) as { id: string }).id;

    stdout.emitData(frame(JSON.stringify({ id: requestId })));
    await result;

    const second = pipe.call("void.method2");
    const secondId = (JSON.parse(stdin.writes[1]!) as { id: string }).id;
    stdout.emitData(frame(JSON.stringify({ id: secondId, result: { ok: true } })));

    await expect(second).resolves.toEqual({ ok: true });
  });

  it("rejects frames that have neither id nor any of result/error/event", () => {
    const fixture = buildPipe();

    fixture.stdout.emitData(frame(JSON.stringify({ foo: "bar" })));

    const err = fixture.terminalError;
    expect(err).not.toBeNull();
    expect((err as unknown as { code: string }).code).toBe("server.protocol-error");
  });
});

describe("createNdjsonPipe fire() — fire-and-forget notification path", () => {
  it("writes a frame to stdin and returns immediately without awaiting the ack", () => {
    const { stdin, pipe } = buildPipe();

    const result = pipe.fire("lsp.notify", { serverId: "srv-1", message: {} });
    expect(result).toBeUndefined();

    expect(stdin.writes).toHaveLength(1);
    const frame = JSON.parse(stdin.writes[0]!) as { id: string; method: string };
    expect(frame.method).toBe("lsp.notify");
    expect(typeof frame.id).toBe("string");
  });

  it("does not crash the channel when the ack response arrives after fire()", async () => {
    const { stdout, stdin, pipe } = buildPipe();

    pipe.fire("lsp.notify", { serverId: "srv-1", message: {} });
    const requestId = (JSON.parse(stdin.writes[0]!) as { id: string }).id;

    stdout.emitData(Buffer.from(`${JSON.stringify({ id: requestId, result: null })}\n`, "utf8"));

    const second = pipe.call("lsp.send", { serverId: "srv-1", message: {} });
    const secondId = (JSON.parse(stdin.writes[1]!) as { id: string }).id;
    stdout.emitData(
      Buffer.from(`${JSON.stringify({ id: secondId, result: { ok: true } })}\n`, "utf8"),
    );

    await expect(second).resolves.toEqual({ ok: true });
  });

  it("silently no-ops when the pipe is disposed", () => {
    const { pipe } = buildPipe();
    pipe.dispose();

    expect(() => pipe.fire("lsp.notify", {})).not.toThrow();
  });
});
