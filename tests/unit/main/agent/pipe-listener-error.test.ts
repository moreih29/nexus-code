/**
 * Event listeners run synchronously inside the stdout data handler. One that
 * throws must not take the rest of the chunk, or the other subscribers, down
 * with it.
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
});
