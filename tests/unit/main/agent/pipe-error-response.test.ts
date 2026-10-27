/**
 * An error response rejects its request with an Error carrying the frame's
 * code and, when present, its structured data (such as the classified kind
 * of a failed git push).
 */
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
  emitLine(value: unknown): void {
    this.emit("data", Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
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

  idAt(index: number): string {
    return (JSON.parse(this.writes[index] ?? "{}") as { id: string }).id;
  }
}

function buildPipe() {
  const stdout = new FakeReadable();
  const stdin = new FakeWritable();
  const pipe = createNdjsonPipe({
    stdout: stdout as unknown as Readable,
    stderr: new FakeReadable() as unknown as Readable,
    stdin: stdin as unknown as Writable,
    classifyStderr: () => null,
    onTerminalError: () => {},
  });
  stdout.emitLine({ type: "ready", protocolVersion: `${AGENT_PROTOCOL_VERSION}.0` });
  return { stdout, stdin, pipe };
}

async function rejection(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Record<string, unknown>;
}

describe("createNdjsonPipe error responses", () => {
  it("rejects with the frame's code, message, and data", async () => {
    const { stdout, stdin, pipe } = buildPipe();
    const push = pipe.call("git.push");
    stdout.emitLine({
      id: stdin.idAt(0),
      error: {
        code: "server.request-failed",
        message: "! [rejected] main -> main (non-fast-forward)",
        data: { errorKind: "non-fast-forward", errorHint: { kind: "pull-then-retry" } },
      },
    });

    const error = await rejection(push);
    expect(error.message).toBe("! [rejected] main -> main (non-fast-forward)");
    expect(error.code).toBe("server.request-failed");
    expect(error.data).toEqual({
      errorKind: "non-fast-forward",
      errorHint: { kind: "pull-then-retry" },
    });
  });

  it("leaves data off an error frame without any", async () => {
    const { stdout, stdin, pipe } = buildPipe();
    const stat = pipe.call("fs.stat");
    stdout.emitLine({ id: stdin.idAt(0), error: { code: "NOT_FOUND", message: "gone" } });

    const error = await rejection(stat);
    expect(error.code).toBe("NOT_FOUND");
    expect("data" in error).toBe(false);
  });
});
