import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { ServerError, UnreachableError } from "../../../../../src/main/features/remote/errors";
import {
  refusalOf,
  VoiceSessions,
  type VoiceSocket,
} from "../../../../../src/main/features/remote/voice";
import type { VoiceEvent } from "../../../../../src/shared/remote/voice";

const OPEN = 1;

class FakeSocket extends EventEmitter {
  readyState = OPEN;
  sent: (string | Uint8Array)[] = [];
  closedWith: number | undefined;
  constructor(readonly url: string) {
    super();
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closedWith = code;
    this.readyState = 3;
    this.emit("close", code ?? 1005);
  }
  terminate() {
    this.readyState = 3;
    this.emit("close", 1006);
  }
  /** The server says something. */
  say(message: object) {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }
  /** The server refuses the upgrade. */
  refuse(statusCode: number, body: object) {
    const response = new EventEmitter() as EventEmitter & { statusCode: number };
    response.statusCode = statusCode;
    this.emit("unexpected-response", {}, response);
    response.emit("data", Buffer.from(JSON.stringify(body)));
    response.emit("end");
  }
}

const signedIn = {
  status: "signed-in" as const,
  server: "https://nexus.example",
  user: { id: "u1", email: "a@example.com", name: "A" },
  device: { id: "d1", name: "Mac", platform: "darwin" },
};

function setup(options: {
  state?: unknown;
  info?: () => Promise<unknown>;
  request?: (method: string, path: string) => Promise<unknown>;
}) {
  const sockets: FakeSocket[] = [];
  const events: VoiceEvent[] = [];
  const voice = new VoiceSessions({
    account: {
      state: () => (options.state ?? signedIn) as never,
      info: (options.info ??
        (async () => ({ signIn: ["google"], voice: { version: 1 } }))) as never,
      request: (options.request ?? (async () => ({ ticket: "t-1" }))) as never,
    },
    emit: (event) => events.push(event),
    socket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as VoiceSocket;
    },
  });
  /** Waits for the next socket a start opens. */
  let seen = 0;
  const socket = async () => {
    for (let i = 0; i < 20 && sockets.length <= seen; i++) await Promise.resolve();
    const s = sockets[seen];
    if (!s) throw new Error("no socket");
    seen += 1;
    return s;
  };
  return { voice, events, socket, sockets };
}

describe("voice input's socket", () => {
  test("opens /voice with the ticket and language, and is ready at the server's rate", async () => {
    const { voice, socket } = setup({});
    const started = voice.start("ko");
    const s = await socket();
    expect(s.url).toBe("wss://nexus.example/voice?v=1&lang=ko&ticket=t-1");
    s.say({ t: "ready", format: "pcm_s16le", sampleRate: 16000, maxSeconds: 600 });
    const result = await started;
    expect(result).toMatchObject({ status: "ready", sampleRate: 16000, maxSeconds: 600 });
  });

  test("passes the server's text on, sends audio and end, and says when it closed", async () => {
    const { voice, events, socket } = setup({});
    const started = voice.start("en");
    const s = await socket();
    s.say({ t: "ready", format: "pcm_s16le", sampleRate: 16000, maxSeconds: 600 });
    const result = await started;
    if (result.status !== "ready") throw new Error("not ready");
    voice.audio(result.id, new Uint8Array([1, 0, 2, 0]));
    voice.audio("another", new Uint8Array([9, 9]));
    s.say({ t: "partial", text: "hello" });
    s.say({ t: "final", text: "hello world" });
    voice.stop(result.id);
    // Audio after the stop is not sent.
    voice.audio(result.id, new Uint8Array([3, 0]));
    s.say({ t: "done", seconds: 2 });
    s.close(1000);
    expect(s.sent).toEqual([new Uint8Array([1, 0, 2, 0]), '{"t":"end"}']);
    expect(events.map((e) => e.event)).toEqual([
      { t: "partial", text: "hello" },
      { t: "final", text: "hello world" },
      { t: "done", seconds: 2 },
      { t: "closed", code: 1000 },
    ]);
    // Closed, another may start.
    const again = voice.start("en");
    (await socket()).say({ t: "ready", format: "pcm_s16le", sampleRate: 24000, maxSeconds: 10 });
    expect((await again).status).toBe("ready");
  });

  test("tells a refused upgrade by its status: quota, busy, unavailable, signed out", async () => {
    for (const [status, error, reason] of [
      [403, "quota_exceeded", "quota"],
      [429, "too_many_sessions", "busy"],
      [503, "voice_unavailable", "unavailable"],
      [401, "unauthorized", "signed-out"],
    ] as const) {
      const { voice, socket } = setup({});
      const started = voice.start("ko");
      (await socket()).refuse(status, { error });
      expect(await started).toMatchObject({ status: "failed", reason });
    }
    expect(refusalOf(500, undefined)).toBe("failed");
  });

  test("does not open a socket signed out, or where the server has no voice", async () => {
    const out = setup({ state: { status: "signed-out", server: "https://nexus.example" } });
    expect(await out.voice.start("ko")).toMatchObject({ status: "failed", reason: "signed-out" });
    const none = setup({ info: async () => ({ signIn: ["google"], voice: null }) });
    expect(await none.voice.start("ko")).toMatchObject({ status: "failed", reason: "unavailable" });
    expect(none.sockets).toHaveLength(0);
  });

  test("an unreachable server, or a socket that fails before ready, is the network", async () => {
    const down = setup({
      info: async () => {
        throw new UnreachableError(new TypeError("fetch failed"));
      },
    });
    expect(await down.voice.start("ko")).toMatchObject({ status: "failed", reason: "network" });
    const refused = setup({
      request: async () => {
        throw new ServerError(500, undefined, "POST /relay/ticket");
      },
    });
    expect(await refused.voice.start("ko")).toMatchObject({ status: "failed", reason: "failed" });
    const dropped = setup({});
    const started = dropped.voice.start("ko");
    const s = await dropped.socket();
    s.emit("error", new Error("ECONNRESET"));
    s.terminate();
    expect(await started).toMatchObject({ status: "failed", reason: "network" });
  });

  test("one session at a time", async () => {
    const { voice, socket } = setup({});
    const first = voice.start("ko");
    expect(await voice.start("ko")).toMatchObject({ status: "failed", reason: "in-use" });
    (await socket()).say({ t: "ready", format: "pcm_s16le", sampleRate: 16000, maxSeconds: 1 });
    expect((await first).status).toBe("ready");
    expect(await voice.start("ko")).toMatchObject({ status: "failed", reason: "in-use" });
  });

  test("a dropped connection mid-session is told with its close code", async () => {
    const { voice, events, socket } = setup({});
    const started = voice.start("ko");
    const s = await socket();
    s.say({ t: "ready", format: "pcm_s16le", sampleRate: 16000, maxSeconds: 600 });
    await started;
    s.say({ t: "final", text: "안녕" });
    s.terminate();
    expect(events.map((e) => e.event)).toEqual([
      { t: "final", text: "안녕" },
      { t: "closed", code: 1006 },
    ]);
  });
});
