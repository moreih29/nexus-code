/**
 * The remote protocol's shapes: what the relay takes and gives, what a
 * sealed message holds, and the methods' params and results.
 */
import { describe, expect, test } from "bun:test";
import {
  aadOf,
  bundleAadOf,
  CAPABILITIES,
  ChatPageSchema,
  ClientFrameSchema,
  isRpcMethod,
  KeyBundlePutSchema,
  KeyBundleSchema,
  MAX_ATTACHMENT_BYTES,
  RPC_METHODS,
  SCHEMA_VERSION,
  SealedMessageSchema,
  ServerFrameSchema,
  ViewItemSchema,
} from "../../../../packages/remote-protocol/src";

const status = {
  agent: "claude" as const,
  title: "NexusCloud-P",
  running: false,
  process: "running" as const,
  turn: null,
  streaming: null,
  permissions: [],
};

describe("the relay's frames", () => {
  test("a message to one device or all, sealed", () => {
    const frame = { t: "send", to: "*", seq: 1, kid: 0, nonce: "abc_-", box: "AAAA" };
    expect(ClientFrameSchema.parse(frame)).toEqual(frame);
    expect(ClientFrameSchema.safeParse({ ...frame, seq: 0 }).success).toBe(false);
    expect(ClientFrameSchema.safeParse({ ...frame, box: "not base64url!" }).success).toBe(false);
  });

  test("what the relay delivers names the sender; presence lists the room", () => {
    const delivered = ServerFrameSchema.parse({
      t: "message",
      from: "dev-a",
      to: "dev-b",
      seq: 3,
      kid: 1,
      nonce: "n",
      box: "b",
    });
    expect(delivered.t).toBe("message");
    const presence = ServerFrameSchema.parse({
      t: "presence",
      self: "dev-b",
      devices: [{ id: "dev-a", name: "Mac", platform: "darwin", online: true }],
    });
    expect(presence.t === "presence" && presence.devices[0]?.online).toBe(true);
  });

  test("the associated data binds a message to its routing", () => {
    const frame = { from: "dev-a", to: "dev-b", seq: 7, kid: 2 };
    expect(aadOf(frame)).toBe("nexus-remote/v1|dev-a|dev-b|7|2");
    expect(aadOf({ ...frame, to: "dev-c" })).not.toBe(aadOf(frame));
  });
});

describe("a sealed message", () => {
  test("a hello, a request, an answer and a notification", () => {
    const hello = {
      type: "hello",
      protocol: 1,
      device: { id: "dev-a", name: "Mac", platform: "darwin" },
      app: { name: "nexus-code", version: "0.27.0" },
      serves: ["sessions", "chat.read"],
      reply: true,
    };
    expect(SealedMessageSchema.parse(hello)).toEqual(hello);
    for (const message of [
      { jsonrpc: "2.0", id: 1, method: "sessions.list", params: {} },
      { jsonrpc: "2.0", id: 1, result: { workspaces: [], sessions: [] } },
      { jsonrpc: "2.0", id: 1, error: { code: 1001, message: "no such tab" } },
      { jsonrpc: "2.0", method: "chat.update", params: {} },
    ]) {
      expect(SealedMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  test("an error answer keeps its error", () => {
    const answer = { jsonrpc: "2.0", id: 1, error: { code: 1001, message: "no such tab" } };
    expect(SealedMessageSchema.parse(answer)).toEqual(answer);
  });
});

describe("the methods", () => {
  test("each has a capability, params and a result", () => {
    for (const [name, method] of Object.entries(RPC_METHODS)) {
      expect(isRpcMethod(name)).toBe(true);
      expect(method.capability.length).toBeGreaterThan(0);
    }
    expect(isRpcMethod("toString")).toBe(false);
    expect(isRpcMethod("fs.write")).toBe(false);
  });

  test("a chat's page keeps items of kinds this version does not know", () => {
    const page = ChatPageSchema.parse({
      status,
      start: 0,
      total: 3,
      items: [
        { kind: "user", key: "u1", text: "hi", images: [], state: "taken" },
        {
          kind: "assistant",
          key: "a1",
          messageId: "m1",
          blocks: [{ type: "tool", toolUseId: "t1" }],
        },
        { kind: "poll", key: "p1", question: "?" },
      ],
      tools: {
        t1: {
          id: "t1",
          name: "Bash",
          input: { command: "ls" },
          status: "done",
          parentToolUseId: null,
        },
      },
      tasks: {},
      agentItems: {},
    });
    expect(page.items.map((item) => item.kind)).toEqual(["user", "assistant", "poll"]);
    // A known kind must fit its own shape.
    expect(ViewItemSchema.safeParse({ kind: "user", key: "u", text: 1 }).success).toBe(false);
  });

  test("a terminal is read under terminal.read; typed into only under terminal.control", () => {
    const terminal = Object.keys(RPC_METHODS).filter((m) => m.startsWith("terminal."));
    const read = terminal.filter(
      (m) => RPC_METHODS[m as keyof typeof RPC_METHODS].capability === "terminal.read",
    );
    expect(read).toEqual(["terminal.read", "terminal.watch", "terminal.unwatch", "terminal.wait"]);
    // Answering its Claude Code's request is an answer to an agent, as a chat's is.
    expect(RPC_METHODS["terminal.answer"].capability).toBe("chat.control");
    for (const m of terminal.filter((m) => !read.includes(m) && m !== "terminal.answer")) {
      expect(RPC_METHODS[m as keyof typeof RPC_METHODS].capability).toBe("terminal.control");
    }
    expect(RPC_METHODS["terminal.input"].capability).toBe("terminal.control");
  });

  test("the version a hello tells is the package's", async () => {
    const pkg = await Bun.file(
      new URL("../../../../packages/remote-protocol/package.json", import.meta.url),
    ).json();
    expect(SCHEMA_VERSION).toBe(pkg.version);
  });

  test("sessions.list carries the consent prompts waiting on the user; an older list has none", () => {
    const consent = {
      id: "c1",
      at: 1000,
      expiresAt: 91_000,
      expiresInMs: 85_000,
      from: {
        device: { id: "d1", name: "MacBook" },
        workspaceId: "w9",
        tabId: "t9",
        name: "Fix build",
      },
      workspaceId: "w1",
      change: { kind: "terminalInput", detail: "dev server", body: "npm test<enter>" },
      eachTime: false,
      answerable: false,
    };
    const { result } = RPC_METHODS["sessions.list"];
    const listed = result.parse({ workspaces: [], sessions: [], consents: [consent] });
    expect(listed.consents?.[0]?.change.kind).toBe("terminalInput");
    // A kind this version does not name is still a prompt.
    expect(
      result.safeParse({
        workspaces: [],
        sessions: [],
        consents: [{ ...consent, change: { kind: "somethingNew" } }],
      }).success,
    ).toBe(true);
    expect(result.parse({ workspaces: [], sessions: [] }).consents).toBeUndefined();
  });

  test("consent.answer takes once, session or deny, under chat.control", () => {
    const spec = RPC_METHODS["consent.answer"];
    expect(spec.capability).toBe("chat.control");
    expect(spec.params.safeParse({ id: "c1", answer: "session" }).success).toBe(true);
    expect(spec.params.safeParse({ id: "c1", answer: "always" }).success).toBe(false);
  });

  test("a commit is named by its hash alone: git.show, and git.diff's commit", () => {
    const show = RPC_METHODS["git.show"];
    expect(show.capability).toBe("git");
    expect(show.params.safeParse({ workspaceId: "w", hash: "8021fbfd" }).success).toBe(true);
    // Not a ref, nor an option git would take.
    for (const hash of ["HEAD", "main", "--output=x", "abc", "8021fbfd~1"]) {
      expect(show.params.safeParse({ workspaceId: "w", hash }).success).toBe(false);
    }
    const diff = RPC_METHODS["git.diff"].params;
    expect(diff.safeParse({ workspaceId: "w", path: "a.ts", commit: "8021fbfd" }).success).toBe(
      true,
    );
    expect(diff.safeParse({ workspaceId: "w", path: "a.ts", commit: "HEAD~1" }).success).toBe(
      false,
    );
    expect(
      show.result.safeParse({
        hash: "8021fbfd".repeat(5),
        parents: ["3c315849".repeat(5)],
        subject: "feat: x",
        author: "A",
        at: 1,
        files: [{ path: "b.ts", oldPath: "a.ts", status: "R" }],
      }).success,
    ).toBe(true);
  });

  test("files are found by name and searched in, under files, within bounds", () => {
    const find = RPC_METHODS["files.find"];
    expect(find.capability).toBe("files");
    expect(find.params.safeParse({ workspaceId: "w", query: "rpc" }).success).toBe(true);
    expect(find.params.safeParse({ workspaceId: "w", query: "" }).success).toBe(false);
    expect(find.params.safeParse({ workspaceId: "w", query: "x", limit: 201 }).success).toBe(false);
    const search = RPC_METHODS["files.search"];
    expect(search.capability).toBe("files");
    expect(
      search.params.safeParse({ workspaceId: "w", query: "todo", regex: true, include: ["*.ts"] })
        .success,
    ).toBe(true);
    expect(search.params.safeParse({ workspaceId: "w", query: "x", limit: 1001 }).success).toBe(
      false,
    );
    expect(
      search.result.safeParse({
        files: [
          {
            path: "a.ts",
            matches: [{ line: 1, column: 0, length: 4, text: "todo", textStart: 0 }],
          },
        ],
      }).success,
    ).toBe(true);
    // Lines count from 1.
    expect(
      search.result.safeParse({
        files: [{ path: "a.ts", matches: [{ line: 0, column: 0, length: 1, text: "x" }] }],
      }).success,
    ).toBe(false);
  });

  test("a workspace's notes are listed and given photos under notes, a frame's worth at a time", () => {
    const list = RPC_METHODS["notes.list"];
    expect(list.capability).toBe("notes");
    expect(list.result.safeParse({ notes: [{ id: "n1", title: "", updatedAt: 1 }] }).success).toBe(
      true,
    );
    const attach = RPC_METHODS["notes.attach"];
    expect(attach.capability).toBe("notes");
    const photo = { workspaceId: "w", noteId: "n1", mediaType: "image/jpeg", data: "/9j/" };
    expect(attach.params.safeParse({ ...photo, name: "IMG_0001.jpg" }).success).toBe(true);
    expect(attach.params.safeParse({ ...photo, mediaType: "image/heic" }).success).toBe(false);
    expect(
      attach.params.safeParse({
        ...photo,
        data: "A".repeat(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4),
      }).success,
    ).toBe(false);
    expect(CAPABILITIES).toContain("notes");
  });

  test("the sessions' list tells the note being recorded into, and goes without it before 0.6.0", () => {
    const result = RPC_METHODS["sessions.list"].result;
    const recording = {
      workspaceId: "w",
      noteId: "n1",
      title: "주간 회의",
      recordedMs: 65_000,
      at: 1000,
      paused: false,
    };
    expect(result.parse({ workspaces: [], sessions: [], recording }).recording).toEqual(recording);
    expect(result.parse({ workspaces: [], sessions: [] }).recording).toBeUndefined();
    expect(
      result.safeParse({
        workspaces: [],
        sessions: [],
        recording: { ...recording, recordedMs: -1 },
      }).success,
    ).toBe(false);
  });

  test("files.read gives a file's bytes piece by piece, at most a chunk at once", () => {
    const read = RPC_METHODS["files.read"];
    const ask = (more: object) =>
      read.params.safeParse({ workspaceId: "w", path: "a.pdf", ...more });
    expect(ask({ as: "bytes", offset: 524288, length: 524288 }).success).toBe(true);
    expect(ask({ as: "bytes", length: 524289 }).success).toBe(false);
    expect(ask({ as: "text" }).success).toBe(false);
    expect(
      read.result.safeParse({
        kind: "bytes",
        path: "/w/a.pdf",
        data: "JVBERi0=",
        offset: 0,
        size: 5,
      }).success,
    ).toBe(true);
  });

  test("every method's capability is one the protocol names", () => {
    for (const spec of Object.values(RPC_METHODS)) {
      expect(CAPABILITIES as readonly string[]).toContain(spec.capability);
    }
  });
});

describe("the account key's bundle", () => {
  const bundle = {
    v: 1,
    kid: 1,
    kdf: { alg: "argon2id13", ops: 3, mem: 64 * 1024 * 1024, salt: "c2FsdA" },
    nonce: "bm9uY2U",
    box: "Ym94",
  };

  test("keeps its own settings, within bounds", () => {
    expect(KeyBundleSchema.parse(bundle)).toEqual(bundle);
    expect(KeyBundleSchema.safeParse({ ...bundle, kid: 0 }).success).toBe(false);
    expect(
      KeyBundleSchema.safeParse({ ...bundle, kdf: { ...bundle.kdf, mem: 1024 } }).success,
    ).toBe(false);
    expect(KeyBundlePutSchema.parse({ bundle, expected: null }).expected).toBeNull();
  });

  test("is sealed for its user and version", () => {
    expect(bundleAadOf("u1", 2)).toBe("nexus-remote/account-key/v1|u1|2");
    expect(bundleAadOf("u2", 2)).not.toBe(bundleAadOf("u1", 2));
  });
});

describe("the voice socket", () => {
  test("the server's messages, as they come", async () => {
    const { VoiceServerMessageSchema, VoiceClientMessageSchema, VoiceLanguageSchema } =
      await import("../../../../packages/remote-protocol/src");
    for (const message of [
      { t: "ready", format: "pcm_s16le", sampleRate: 16000, maxSeconds: 600 },
      { t: "partial", text: "안녕" },
      { t: "final", text: "안녕하세요." },
      { t: "limit", reason: "quota" },
      { t: "done", seconds: 3.2 },
      { t: "error", code: "provider-error", message: "upstream closed" },
    ]) {
      expect(VoiceServerMessageSchema.parse(message)).toEqual(message as never);
    }
    expect(
      VoiceServerMessageSchema.safeParse({
        t: "ready",
        format: "opus",
        sampleRate: 16000,
        maxSeconds: 1,
      }).success,
    ).toBe(false);
    expect(VoiceClientMessageSchema.parse({ t: "end" })).toEqual({ t: "end" });
    for (const lang of ["ko", "en", "en-US", "multi"])
      expect(VoiceLanguageSchema.parse(lang)).toBe(lang);
    expect(VoiceLanguageSchema.safeParse("korean").success).toBe(false);
  });

  test("a note's session tells speakers apart and where their words fall", async () => {
    const { VoiceServerMessageSchema, VoicePurposeSchema } = await import(
      "../../../../packages/remote-protocol/src"
    );
    for (const message of [
      { t: "partial", text: "네, 512", speaker: "2" },
      { t: "final", text: "네, 512 KiB면 괜찮아요.", speaker: "2", startMs: 4210, endMs: 6930 },
      { t: "done", seconds: 1820.4, transcribeToken: "tt_1" },
    ]) {
      expect(VoiceServerMessageSchema.parse(message)).toEqual(message as never);
    }
    expect(VoiceServerMessageSchema.safeParse({ t: "final", text: "x", speaker: "" }).success).toBe(
      false,
    );
    expect(VoiceServerMessageSchema.safeParse({ t: "final", text: "x", startMs: -1 }).success).toBe(
      false,
    );
    expect(VoicePurposeSchema.options).toEqual(["dictation", "note"]);
  });

  test("usage counts notes apart, and an older server's still reads", async () => {
    const { VoiceUsageSchema } = await import("../../../../packages/remote-protocol/src");
    const older = { period: "2026-11", usedSeconds: 60, limitSeconds: 36000 };
    expect(VoiceUsageSchema.parse(older)).toEqual(older);
    const both = { ...older, note: { usedSeconds: 7500, limitSeconds: 72000 } };
    expect(VoiceUsageSchema.parse(both)).toEqual(both);
  });

  test("a second pass: pending, done with its segments, or failed", async () => {
    const { TranscriptionSchema } = await import("../../../../packages/remote-protocol/src");
    for (const t of [
      { id: "tr_1", status: "pending" },
      {
        id: "tr_1",
        status: "done",
        seconds: 1820,
        segments: [{ speaker: "1", startMs: 0, endMs: 2400, text: "시작할게요." }],
      },
      { id: "tr_1", status: "error", message: "unsupported audio" },
    ]) {
      expect(TranscriptionSchema.parse(t)).toEqual(t as never);
    }
    expect(TranscriptionSchema.safeParse({ id: "tr_1", status: "done" }).success).toBe(false);
  });
});
