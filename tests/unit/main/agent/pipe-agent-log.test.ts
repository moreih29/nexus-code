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

test("an agent log record hides values by key name, nested ones too", () => {
  logged.length = 0;
  const stderr = agentStderr();
  const secrets = ["abc123", "pw", "s3", "k1", "k2", "nested", "Basic dXNlcjpwdw==", "c=1"];
  const line = {
    time: "t",
    level: "INFO",
    msg: "auth",
    src: "agent-log",
    token: "abc123",
    password: "pw",
    secret: "s3",
    apiKey: "k1",
    api_key: "k2",
    req: { token: "nested", user: "u", headers: { Authorization: "Basic dXNlcjpwdw==" } },
    cookies: ["c=1"],
    inputTokens: 42,
  };
  stderr.emit("data", Buffer.from(`${JSON.stringify(line)}\n`));

  expect(logged).toHaveLength(1);
  const msg = logged[0]?.msg ?? "";
  for (const secret of secrets) expect(msg).not.toContain(secret);
  expect(msg).toBe(
    'auth token="[redacted]" password="[redacted]" secret="[redacted]" apiKey="[redacted]" ' +
      'api_key=[redacted] req={"token":"[redacted]","user":"u","headers":{"Authorization":[redacted]}} ' +
      'cookies="[redacted]" inputTokens=42',
  );
});

test("an agent log record keeps each value short", () => {
  logged.length = 0;
  const stderr = agentStderr();
  const deep = { a: { b: { c: { d: { e: "deep" } } } } };
  const line = {
    level: "WARN",
    msg: "big",
    src: "agent-log",
    err: "x".repeat(5000),
    list: Array.from({ length: 500 }, (_, i) => `item-${i}`),
    deep,
  };
  stderr.emit("data", Buffer.from(`${JSON.stringify(line)}\n`));

  const msg = logged[0]?.msg ?? "";
  const attrs = msg.slice("big ".length).split(/ (?=[a-z]+=)/);
  expect(attrs.map((attr) => attr.slice(0, attr.indexOf("=")))).toEqual(["err", "list", "deep"]);
  for (const attr of attrs) expect(attr.length).toBeLessThanOrEqual("list=".length + 1024);
  expect(attrs[0]).toBe(`err=${JSON.stringify(`${"x".repeat(511)}…`)}`);
  expect(attrs[2]).toBe('deep={"a":{"b":{"c":{"d":"[…]"}}}}');
  expect(msg).not.toContain('deep"}');
});
