/**
 * Agent stdout arrives in arbitrary chunks (64 KiB locally, smaller over
 * SSH). A frame's multi-byte UTF-8 characters — Go emits non-ASCII as raw
 * UTF-8 inside JSON strings — must survive a chunk boundary falling in the
 * middle of one, and lines spread over many chunks must be reassembled.
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

function buildPipe() {
  const stdout = new FakeReadable();
  const writes: string[] = [];
  const stdin = {
    writable: true,
    destroyed: false,
    write(line: string, callback?: (error?: Error | null) => void): boolean {
      writes.push(line);
      callback?.();
      return true;
    },
  };
  const pipe = createNdjsonPipe({
    stdout: stdout as unknown as Readable,
    stderr: new FakeReadable() as unknown as Readable,
    stdin: stdin as unknown as Writable,
    classifyStderr: () => null,
    onTerminalError: () => {},
  });
  stdout.emit(
    "data",
    Buffer.from(
      `${JSON.stringify({ type: "ready", protocolVersion: `${AGENT_PROTOCOL_VERSION}.0` })}\n`,
    ),
  );
  const lastRequestId = () => (JSON.parse(writes.at(-1) ?? "{}") as { id: string }).id;
  return { stdout, pipe, lastRequestId };
}

describe("createNdjsonPipe UTF-8 chunking", () => {
  it("keeps a multi-byte character intact when a chunk boundary splits it", async () => {
    const { stdout, pipe, lastRequestId } = buildPipe();
    const content = "한글 내용 😀 끝";
    const result = pipe.call("fs.readFile");
    const bytes = Buffer.from(`${JSON.stringify({ id: lastRequestId(), result: { content } })}\n`);

    // One byte per chunk splits every multi-byte character.
    for (let i = 0; i < bytes.length; i++) {
      stdout.emit("data", bytes.subarray(i, i + 1));
    }

    await expect(result).resolves.toEqual({ content });
  });

  it("splits several frames delivered in one chunk and one frame across chunks", async () => {
    const { stdout, pipe, lastRequestId } = buildPipe();
    const first = pipe.call("a");
    const firstId = lastRequestId();
    const second = pipe.call("b");
    const secondId = lastRequestId();
    const text = Buffer.from(
      `${JSON.stringify({ id: firstId, result: "가나다" })}\n${JSON.stringify({ id: secondId, result: "라마바" })}\n`,
    );
    const cut = text.indexOf(0x0a) + 5;

    stdout.emit("data", text.subarray(0, cut));
    stdout.emit("data", text.subarray(cut));

    await expect(first).resolves.toBe("가나다");
    await expect(second).resolves.toBe("라마바");
  });
});
