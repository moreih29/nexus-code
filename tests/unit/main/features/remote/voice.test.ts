import { describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { ServerError, UnreachableError } from "../../../../../src/main/features/remote/errors";
import { SocketRetryAfter } from "../../../../../src/main/features/remote/retry-after";
import { ServerRoute } from "../../../../../src/main/features/remote/route";
import {
  refusalOf,
  ticketBody,
  VoiceSessions,
  type VoiceSocket,
} from "../../../../../src/main/features/remote/voice";
import { RecentErrors, type RecordError } from "../../../../../src/main/infra/recent-errors";
import { VOICE_CLOSE_SIGNED_OUT, type VoiceEvent } from "../../../../../src/shared/remote/voice";

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
  say(message: object) {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }
  refuse(statusCode: number, body: object, retryAfter?: string) {
    const response = Object.assign(new EventEmitter(), {
      statusCode,
      headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
      destroy() {},
    });
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
  request?: (method: string, path: string, body?: unknown) => Promise<unknown>;
  upload?: (path: string, bytes: Uint8Array, options: unknown) => Promise<unknown>;
  purpose?: "dictation" | "note";
  route?: ServerRoute;
  retryAfter?: SocketRetryAfter;
  recheckSignIn?: () => void;
  names?: () => Promise<readonly string[]>;
  recordError?: RecordError;
}) {
  const sockets: FakeSocket[] = [];
  const events: VoiceEvent[] = [];
  const voice = new VoiceSessions({
    account: {
      state: () => (options.state ?? signedIn) as never,
      info: (options.info ??
        (async () => ({ signIn: ["google"], voice: { version: 1 } }))) as never,
      request: (options.request ?? (async () => ({ ticket: "t-1" }))) as never,
      upload: (options.upload ?? (async () => ({ id: "tr-1" }))) as never,
      route: options.route ?? new ServerRoute("https://nexus.example"),
      recheckSignIn: options.recheckSignIn ?? (() => {}),
    },
    ...(options.purpose ? { purpose: options.purpose } : {}),
    ...(options.names ? { names: options.names } : {}),
    ...(options.retryAfter ? { retryAfter: options.retryAfter } : {}),
    ...(options.recordError ? { recordError: options.recordError } : {}),
    emit: (event) => events.push(event),
    socket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as VoiceSocket;
    },
  });
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
      [403, "not_invited", "signed-out"],
    ] as const) {
      const { voice, socket } = setup({});
      const started = voice.start("ko");
      (await socket()).refuse(status, { error });
      expect(await started).toMatchObject({ status: "failed", reason });
    }
    expect(refusalOf(500, undefined)).toBe("failed");
  });

  test.each([
    ["45", 45_000],
    ["Thu, 01 Jan 2026 00:00:30 GMT", 30_000],
    [undefined, 60_000],
  ] as const)("a voice upgrade 429 with Retry-After %p blocks both kinds of voice", async (header, delay) => {
    const clock = spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
    let now = 0;
    const retryAfter = new SocketRetryAfter(() => now);
    const request = mock(async () => ({ ticket: "mock" }));
    const dictation = setup({ retryAfter, request });
    const note = setup({ purpose: "note", retryAfter, request });
    try {
      const started = dictation.voice.start("ko");
      (await dictation.socket()).refuse(429, { error: "rate_limited" }, header);
      expect(await started).toMatchObject({ status: "failed", reason: "rate-limited" });
      now = delay - 1;
      expect(await dictation.voice.start("ko")).toMatchObject({ reason: "rate-limited" });
      expect(await note.voice.start("en")).toMatchObject({ reason: "rate-limited" });
      expect(request).toHaveBeenCalledTimes(1);
      expect(note.sockets).toHaveLength(0);

      now = delay;
      const next = note.voice.start("en");
      (await note.socket()).say({
        t: "ready",
        format: "pcm_s16le",
        sampleRate: 16000,
        maxSeconds: 60,
      });
      expect((await next).status).toBe("ready");
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  test("a ticket 429 also blocks an upgrade whose ticket was already in flight", async () => {
    const retryAfter = new SocketRetryAfter(() => 0);
    const pending = Promise.withResolvers<unknown>();
    const asked = Promise.withResolvers<void>();
    const note = setup({
      purpose: "note",
      retryAfter,
      request: () => {
        asked.resolve();
        return pending.promise;
      },
    });
    const dictation = setup({
      retryAfter,
      request: async () => {
        throw new ServerError(429, undefined, "POST /relay/ticket", 60);
      },
    });
    const starting = note.voice.start("en");
    await asked.promise;
    expect(await dictation.voice.start("en")).toMatchObject({ reason: "rate-limited" });
    pending.resolve({ ticket: "mock" });
    expect(await starting).toMatchObject({ reason: "rate-limited" });
    expect(dictation.sockets).toHaveLength(0);
    expect(note.sockets).toHaveLength(0);
    expect(retryAfter.remaining()).toBe(60_000);
  });

  test.each([
    false,
    true,
  ])("a 4001 rechecks sign-in with ready=%p and never reconnects", async (ready) => {
    const recheckSignIn = mock(() => {});
    const { voice, events, socket, sockets } = setup({ recheckSignIn });
    const started = voice.start("en");
    const s = await socket();
    if (ready) s.say({ t: "ready", format: "pcm_s16le", sampleRate: 16000, maxSeconds: 60 });
    s.close(VOICE_CLOSE_SIGNED_OUT);
    const result = await started;
    if (ready) {
      if (result.status !== "ready") throw new Error("not ready");
      expect(voice.has(result.id)).toBe(false);
      expect(events).toEqual([
        { id: result.id, event: { t: "closed", code: VOICE_CLOSE_SIGNED_OUT } },
      ]);
    } else {
      expect(result).toMatchObject({ status: "failed", reason: "signed-out" });
      expect(events).toEqual([]);
    }
    expect(recheckSignIn).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
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
    const outdated = setup({
      request: async () => {
        throw new ServerError(400, "unsupported_version", "POST /relay/ticket");
      },
    });
    expect(await outdated.voice.start("ko")).toMatchObject({
      status: "failed",
      reason: "outdated",
    });
    const dropped = setup({});
    const started = dropped.voice.start("ko");
    const s = await dropped.socket();
    s.emit("error", new Error("ECONNRESET"));
    s.terminate();
    expect(await started).toMatchObject({ status: "failed", reason: "network" });
  });

  test("records the server's refusal of a socket by its code only", async () => {
    const errors = new RecentErrors(() => 0);
    const refused = setup({ purpose: "note", recordError: errors.record });
    const started = refused.voice.start("ko");
    (await refused.socket()).say({
      t: "error",
      code: "provider-error",
      message: "keyterm Kim MacBook Pro is too long",
    });
    expect(await started).toMatchObject({
      status: "failed",
      reason: "failed",
      message: "keyterm Kim MacBook Pro is too long",
    });
    expect(errors.list()).toEqual([{ ago: 0, area: "voice", code: "note:failed" }]);
  });

  test("records a failed transcription by its code only", async () => {
    const errors = new RecentErrors(() => 0);
    const { voice } = setup({
      purpose: "note",
      recordError: errors.record,
      request: async () => ({
        id: "tr-1",
        status: "error",
        message: "keyterm my-secret-project was refused",
      }),
    });
    expect(await voice.transcription("tr-1")).toMatchObject({ status: "error" });
    expect(errors.list()).toEqual([{ ago: 0, area: "voice", code: "transcription:error" }]);
  });

  test("records a socket that failed to get ready, with its purpose and reason", async () => {
    const errors = new RecentErrors(() => 0);
    const dropped = setup({ purpose: "note", recordError: errors.record });
    const started = dropped.voice.start("ko");
    const s = await dropped.socket();
    s.emit("error", new Error("connect ECONNREFUSED 10.1.2.3:443"));
    s.terminate();
    await started;
    expect(errors.list()).toEqual([
      { ago: 0, area: "voice", code: "note:network", message: "connect ECONNREFUSED <ip>:443" },
    ]);
    const ready = setup({ recordError: errors.record });
    const opened = ready.voice.start("ko");
    (await ready.socket()).say({
      t: "ready",
      format: "pcm_s16le",
      sampleRate: 16000,
      maxSeconds: 600,
    });
    await opened;
    expect(errors.list()).toHaveLength(1);
  });

  test("goes through the proxy, and straight once a socket to it fails before ready", async () => {
    const route = new ServerRoute("https://nexus.example", "https://proxy.example", () => 0);
    const { voice, socket } = setup({ route });
    const first = voice.start("ko");
    const s = await socket();
    expect(s.url).toBe("wss://proxy.example/voice?v=1&lang=ko&ticket=t-1");
    s.emit("error", new Error("ECONNREFUSED"));
    expect(await first).toMatchObject({ status: "failed", reason: "network" });
    voice.start("ko");
    expect((await socket()).url).toBe("wss://nexus.example/voice?v=1&lang=ko&ticket=t-1");
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

describe("a note's recording", () => {
  test("asks for a note's session, and passes its voices, times and token on", async () => {
    const { voice, events, socket } = setup({ purpose: "note" });
    const started = voice.start("ko");
    const s = await socket();
    expect(s.url).toBe("wss://nexus.example/voice?v=1&lang=ko&purpose=note&ticket=t-1");
    s.say({ t: "ready", format: "pcm_s16le", sampleRate: 16000, maxSeconds: 3600 });
    const result = await started;
    if (result.status !== "ready") throw new Error("not ready");
    expect(voice.has(result.id)).toBe(true);
    expect(voice.has("another")).toBe(false);
    s.say({ t: "final", text: "안녕하세요", speaker: "2", startMs: 100, endMs: 900 });
    s.say({ t: "error", code: "provider-error", message: "x", transcribeToken: "tok" });
    s.say({ t: "done", seconds: 1, transcribeToken: "tok" });
    expect(events.map((e) => e.event)).toEqual([
      { t: "final", text: "안녕하세요", speaker: "2", startMs: 100, endMs: 900 },
      { t: "error", code: "provider-error", message: "x", transcribeToken: "tok" },
      { t: "done", seconds: 1, transcribeToken: "tok" },
    ]);
  });

  test("sends a take for a second pass with its token, and tells why one was refused", async () => {
    const calls: { path: string; bytes: Uint8Array; options: unknown }[] = [];
    let answer: () => Promise<unknown> = async () => ({ id: "tr-9" });
    const { voice } = setup({
      purpose: "note",
      upload: async (path, bytes, options) => {
        calls.push({ path, bytes, options });
        return answer();
      },
    });
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await voice.transcribe(bytes, "audio/webm", "tok", "ko")).toEqual({
      status: "submitted",
      id: "tr-9",
    });
    expect(calls[0]).toEqual({
      path: "/voice/transcriptions?v=1&lang=ko",
      bytes,
      options: { type: "audio/webm", headers: { "x-transcribe-token": "tok" } },
    });
    for (const [status, code, reason] of [
      [403, undefined, "expired"],
      [403, "quota_exceeded", "quota"],
      [429, "too_many_transcriptions", "busy"],
      [413, undefined, "too-big"],
      [500, undefined, "failed"],
    ] as const) {
      answer = async () => {
        throw new ServerError(status, code, "POST /voice/transcriptions");
      };
      expect(await voice.transcribe(bytes, "audio/webm", "tok", "ko")).toMatchObject({
        status: "failed",
        reason,
      });
    }
    answer = async () => {
      throw new UnreachableError(new TypeError("fetch failed"));
    };
    expect(await voice.transcribe(bytes, "audio/webm", "tok", "ko")).toMatchObject({
      status: "failed",
      reason: "network",
    });
  });

  test("asks after a second pass, and has it dropped", async () => {
    const asked: string[] = [];
    const { voice } = setup({
      purpose: "note",
      request: async (method, path) => {
        asked.push(`${method} ${path}`);
        if (method === "DELETE") return {};
        return {
          id: "tr-1",
          status: "done",
          seconds: 3,
          segments: [{ speaker: "1", startMs: 0, endMs: 1200, text: "hi" }],
        };
      },
    });
    expect(await voice.transcription("tr-1")).toMatchObject({ status: "done", seconds: 3 });
    await voice.dropTranscription("tr-1");
    expect(asked).toEqual(["GET /voice/transcriptions/tr-1", "DELETE /voice/transcriptions/tr-1"]);
  });
});

describe("the terms voice input listens for", () => {
  test("a ticket's body carries the names, deduped, capped and clipped; none without names", () => {
    expect(ticketBody([])).toBeUndefined();
    expect(ticketBody(["  ", ""])).toBeUndefined();
    expect(ticketBody(["Mac Studio", "mac studio", " api-server "])).toEqual({
      voiceTerms: ["Mac Studio", "api-server"],
    });
    const many = Array.from({ length: 80 }, (_, i) => `workspace-${i}`);
    expect(ticketBody(many)?.voiceTerms).toHaveLength(60);
    expect(ticketBody(["x".repeat(100)])?.voiceTerms).toEqual(["x".repeat(80)]);
  });

  test("a session's ticket is asked with the names in its body, never in the socket's URL", async () => {
    const asked: { method: string; path: string; body: unknown }[] = [];
    const { voice, socket } = setup({
      names: async () => ["Mac Studio", "api-server"],
      request: async (method, path, body) => {
        asked.push({ method, path, body });
        return { ticket: "t-1" };
      },
    });
    const started = voice.start("ko");
    const s = await socket();
    expect(asked).toEqual([
      {
        method: "POST",
        path: "/relay/ticket?v=2",
        body: { voiceTerms: ["Mac Studio", "api-server"] },
      },
    ]);
    expect(s.url).toBe("wss://nexus.example/voice?v=1&lang=ko&ticket=t-1");
    s.say({ t: "ready", format: "pcm_s16le", sampleRate: 16000, maxSeconds: 600 });
    expect((await started).status).toBe("ready");
  });

  test("without names, or when gathering them fails, the ticket is asked with no body", async () => {
    for (const names of [undefined, async () => [], async () => Promise.reject(new Error("x"))]) {
      const bodies: unknown[] = [];
      const { voice, socket } = setup({
        ...(names ? { names } : {}),
        request: async (_method, _path, body) => {
          bodies.push(body);
          return { ticket: "t-1" };
        },
      });
      const started = voice.start("en");
      (await socket()).say({ t: "ready", format: "pcm_s16le", sampleRate: 16000, maxSeconds: 9 });
      expect((await started).status).toBe("ready");
      expect(bodies).toEqual([undefined]);
    }
  });

  test("a note's session sends the names too", async () => {
    const bodies: unknown[] = [];
    const { voice, socket } = setup({
      purpose: "note",
      names: async () => ["Work PC"],
      request: async (_method, _path, body) => {
        bodies.push(body);
        return { ticket: "t-1" };
      },
    });
    const started = voice.start("ko");
    (await socket()).say({ t: "ready", format: "pcm_s16le", sampleRate: 16000, maxSeconds: 9 });
    await started;
    expect(bodies).toEqual([{ voiceTerms: ["Work PC"] }]);
  });

  test("reads the account's terms, and replaces them with the list the server kept", async () => {
    const asked: { method: string; path: string; body: unknown }[] = [];
    const { voice } = setup({
      request: async (method, path, body) => {
        asked.push({ method, path, body });
        return method === "GET" ? { terms: ["Soniox"] } : { terms: ["Soniox", "Tauri"] };
      },
    });
    expect(await voice.terms()).toEqual(["Soniox"]);
    expect(await voice.setTerms(["Soniox", " Tauri ", "soniox"])).toEqual(["Soniox", "Tauri"]);
    expect(asked).toEqual([
      { method: "GET", path: "/voice/terms", body: undefined },
      { method: "PUT", path: "/voice/terms", body: { terms: ["Soniox", " Tauri ", "soniox"] } },
    ]);
  });

  test("a server answer without a list of terms is an error", async () => {
    const { voice } = setup({ request: async () => ({ terms: "no" }) });
    await expect(voice.terms()).rejects.toThrow();
  });
});

test("an oversized voice upgrade refusal fails and aborts the response", async () => {
  const { voice, socket } = setup({});
  const started = voice.start("ko");
  const s = await socket();
  let aborted = false;
  const response = Object.assign(new EventEmitter(), {
    statusCode: 403,
    headers: {},
    destroy: () => {
      aborted = true;
    },
  });
  s.emit("unexpected-response", {}, response);
  const chunk = Buffer.alloc(1024 * 1024, 0x20);
  for (let i = 0; i < 8; i += 1) response.emit("data", chunk);
  response.emit("data", Buffer.from(" "));
  response.emit("end");
  expect(await started).toMatchObject({ status: "failed", reason: "response-too-large" });
  expect(aborted).toBe(true);
  expect(s.readyState).toBe(3);
});
