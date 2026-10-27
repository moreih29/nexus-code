/**
 * A request that times out locally is still answered by the agent once its
 * handler finishes. That late answer must be absorbed: treating it as an
 * unknown id used to fail the whole channel with server.protocol-error, so
 * one slow git or search call took the workspace connection down with it.
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
  let terminalError: Error | null = null;
  const pipe = createNdjsonPipe({
    stdout: stdout as unknown as Readable,
    stderr: new FakeReadable() as unknown as Readable,
    stdin: stdin as unknown as Writable,
    classifyStderr: () => null,
    onTerminalError: (error) => {
      terminalError = error;
    },
    requestTimeoutMs: 5,
  });
  stdout.emitLine({ type: "ready", protocolVersion: `${AGENT_PROTOCOL_VERSION}.0` });
  return {
    stdout,
    stdin,
    pipe,
    get terminalError(): Error | null {
      return terminalError;
    },
  };
}

async function expectTimeout(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect((error as { code?: string } | null)?.code).toBe("ssh.unknown");
}

describe("createNdjsonPipe late responses", () => {
  it("absorbs a result that arrives after its request timed out", async () => {
    const fixture = buildPipe();
    const slow = fixture.pipe.call("git.log");
    await expectTimeout(slow);

    fixture.stdout.emitLine({ id: fixture.stdin.idAt(0), result: { entries: [] } });
    expect(fixture.terminalError).toBeNull();

    const next = fixture.pipe.call("fs.stat");
    fixture.stdout.emitLine({ id: fixture.stdin.idAt(1), result: { ok: true } });
    await expect(next).resolves.toEqual({ ok: true });
  });

  it("absorbs an error response that arrives after its request timed out", async () => {
    const fixture = buildPipe();
    await expectTimeout(fixture.pipe.call("search.text"));

    fixture.stdout.emitLine({
      id: fixture.stdin.idAt(0),
      error: { code: "INTERNAL", message: "cancelled" },
    });
    expect(fixture.terminalError).toBeNull();
  });

  it("still fails the channel on a response to an id it never issued", () => {
    const fixture = buildPipe();
    fixture.stdout.emitLine({ id: "r-999", result: null });
    expect((fixture.terminalError as { code?: string } | null)?.code).toBe("server.protocol-error");
  });

  it("still fails the channel when a timed-out id is answered twice", async () => {
    const fixture = buildPipe();
    await expectTimeout(fixture.pipe.call("git.log"));
    const id = fixture.stdin.idAt(0);

    fixture.stdout.emitLine({ id, result: null });
    expect(fixture.terminalError).toBeNull();
    fixture.stdout.emitLine({ id, result: null });
    expect((fixture.terminalError as { code?: string } | null)?.code).toBe("server.protocol-error");
  });

  it("lets one call outlast the pipe's request timeout", async () => {
    const fixture = buildPipe();
    // The pipe times requests out after 5 ms; this push waits on a prompt.
    const push = fixture.pipe.call("git.push", {}, { timeoutMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 30));

    fixture.stdout.emitLine({ id: fixture.stdin.idAt(0), result: { pushed: true } });
    await expect(push).resolves.toEqual({ pushed: true });
  });
});
