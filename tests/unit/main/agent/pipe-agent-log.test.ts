import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

const logged: { level: string; msg: string; meta?: unknown }[] = [];
const realLog = await import("../../../../src/shared/log/main");
mock.module("../../../../src/shared/log/main", () => ({
  ...realLog,
  createLogger: () => ({
    error: (msg: string, meta?: unknown) => logged.push({ level: "error", msg, meta }),
    warn: (msg: string, meta?: unknown) => logged.push({ level: "warn", msg, meta }),
    info: (msg: string, meta?: unknown) => logged.push({ level: "info", msg, meta }),
    debug: (msg: string, meta?: unknown) => logged.push({ level: "debug", msg, meta }),
  }),
}));
const { createNdjsonPipe } = await import("../../../../src/main/infra/agent/pipe");

class FakeReadable extends EventEmitter {
  pause(): this {
    return this;
  }
  resume(): this {
    return this;
  }
}

function agentStderr(): FakeReadable {
  const stderr = new FakeReadable();
  createNdjsonPipe({
    stdout: new FakeReadable() as unknown as Readable,
    stderr: stderr as unknown as Readable,
    stdin: { write: () => true, writable: true, destroyed: false } as unknown as Writable,
    classifyStderr: () => null,
    onTerminalError: () => {},
  });
  return stderr;
}

test("an agent log record keeps its attributes, with secrets hidden", () => {
  logged.length = 0;
  const stderr = agentStderr();
  const reason =
    "hookserver: socket path C:\\Users\\u\\home\\sockets\\h-0123456789ab.sock is 119 bytes, over the 107-byte limit";
  const lines = [
    { time: "t", level: "WARN", msg: "hookserver unavailable", src: "agent-log", err: reason },
    { time: "t", level: "INFO", msg: "plain", src: "agent-log", correlationId: "c1" },
    { time: "t", level: "ERROR", msg: "dial", src: "agent-log", url: "https://me:pw@host/x", n: 3 },
  ];
  stderr.emit("data", Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join("")));

  expect(logged).toEqual([
    { level: "warn", msg: `hookserver unavailable err=${JSON.stringify(reason)}`, meta: undefined },
    { level: "info", msg: "plain", meta: { correlationId: "c1" } },
    { level: "error", msg: 'dial url="https://[redacted]@host/x" n=3', meta: undefined },
  ]);
});
