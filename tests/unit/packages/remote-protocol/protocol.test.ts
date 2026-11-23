import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  aadOf,
  bundleAadOf,
  CAPABILITIES,
  ChatPageSchema,
  ChatPanelSchema,
  ClientFrameSchema,
  isRpcMethod,
  KeyBundlePutSchema,
  KeyBundleSchema,
  MAX_ATTACHMENT_BYTES,
  MAX_BYTES_CHUNK,
  MAX_IMAGE_EDGE,
  MAX_MARK_SEEN,
  MAX_PEEK_BYTES,
  MAX_PEEK_TURNS,
  MAX_SESSION_AGENTS,
  MAX_UPLOAD_BYTES,
  NOTE_PAGES_SCHEMA,
  NoteRecordingInfoSchema,
  olderConnection,
  PUSH_VERSION,
  PushPayloadSchema,
  PushRegistrationSchema,
  PushSendResultSchema,
  PushSendSchema,
  RemoteConsentSchema,
  RemoteSessionSchema,
  RPC_METHODS,
  RpcIdSchema,
  RpcResponseSchema,
  SCHEMA_VERSION,
  SealedEnvelopeSchema,
  SealedMessageSchema,
  ServerFrameSchema,
  ServerInfoSchema,
  TURN_FAILURE_KINDS,
  ViewItemSchema,
} from "../../../../packages/remote-protocol/src";

import {
  LegacySessionsList,
  LegacySessionsWatch,
} from "../../../fixtures/remote-protocol/sessions-v0.24.0";

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
    expect(aadOf(frame)).toBe("nexus-remote/v2|dev-a|dev-b|7|2");
    expect(aadOf({ ...frame, to: "dev-c" })).not.toBe(aadOf(frame));
  });
});

describe("0.19.0 wire compatibility", () => {
  test("accepts integer IDs outside the safe range and rejects fractions", () => {
    expect(RpcIdSchema.parse(Number.MAX_SAFE_INTEGER + 1)).toBe(Number.MAX_SAFE_INTEGER + 1);
    expect(RpcIdSchema.safeParse(1.5).success).toBe(false);
    expect(RpcIdSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  test("keeps an absent RPC result and strips unknown fields", () => {
    expect(RpcResponseSchema.parse({ jsonrpc: "2.0", id: 1, extra: true })).toEqual({
      jsonrpc: "2.0",
      id: 1,
    });
  });

  test("accepts UUID-shaped transfer IDs with legacy variant bits", () => {
    const { params } = RPC_METHODS["files.read"];
    const input = {
      workspaceId: "w",
      path: "file",
      transferId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    };
    expect(params.parse(input)).toEqual(input);
    expect(params.safeParse({ ...input, transferId: "not-a-uuid" }).success).toBe(false);
  });

  test("retains unrestricted numbers and validates record values before dropping reserved keys", () => {
    const { result } = RPC_METHODS["browser.permissions"];
    expect(PushSendResultSchema.parse(JSON.parse('{"sent":1e400,"skipped":0}'))).toEqual({
      sent: Number.POSITIVE_INFINITY,
      skipped: 0,
    });
    expect(
      result.parse(JSON.parse('{"global":{"__proto__":true,"camera":true},"sites":[]}')),
    ).toEqual({
      global: { camera: true },
      sites: [],
    });
    expect(result.safeParse(JSON.parse('{"global":{"__proto__":"yes"},"sites":[]}')).success).toBe(
      false,
    );
  });
});

describe("a sealed message", () => {
  test("a hello, a request, an answer and a notification", () => {
    const hello = {
      type: "hello",
      protocol: 2,
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

  test("goes sealed with the sender's epoch and the receiver's, null only to all", () => {
    const message = { jsonrpc: "2.0", id: 1, method: "sessions.list", params: {} };
    const epoch = "AAAAAAAAAAAAAAAAAAAAAA";
    const envelope = { epoch, peer: "BBBBBBBBBBBBBBBBBBBBBB", message };
    expect(SealedEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(SealedEnvelopeSchema.safeParse({ ...envelope, peer: null }).success).toBe(true);
    expect(SealedEnvelopeSchema.safeParse(message).success).toBe(false);
    expect(SealedEnvelopeSchema.safeParse({ ...envelope, epoch: "short" }).success).toBe(false);
    expect(SealedEnvelopeSchema.safeParse({ ...envelope, peer: undefined }).success).toBe(false);
  });

  test("says its sender's connection, since 0.18.0: a run and a number above 0", () => {
    const message = { jsonrpc: "2.0", id: 1, method: "sessions.list", params: {} };
    const envelope = { epoch: "A".repeat(22), peer: "B".repeat(22), message };
    const conn = { boot: "C".repeat(22), n: 1 };
    expect(SealedEnvelopeSchema.parse({ ...envelope, conn })).toEqual({ ...envelope, conn });
    expect(SealedEnvelopeSchema.parse(envelope)).toEqual(envelope);
    for (const bad of [
      { ...conn, n: 0 },
      { ...conn, n: 1.5 },
      { ...conn, boot: "short" },
      { n: 1 },
    ]) {
      expect(SealedEnvelopeSchema.safeParse({ ...envelope, conn: bad }).success).toBe(false);
    }
  });

  const run = "R".repeat(22);
  const other = "S".repeat(22);
  test.each([
    ["an older connection of the same run", { boot: run, n: 2 }, { boot: run, n: 3 }, true],
    ["the same connection number again", { boot: run, n: 3 }, { boot: run, n: 3 }, true],
    ["a newer connection of the same run", { boot: run, n: 4 }, { boot: run, n: 3 }, false],
    ["a lower number of another run", { boot: other, n: 1 }, { boot: run, n: 3 }, false],
    ["no connection said (before 0.18.0)", undefined, { boot: run, n: 3 }, false],
    ["none heard (before 0.18.0)", { boot: run, n: 1 }, undefined, false],
  ] as const)("%s: older is %p", (_, conn, heard, older) => {
    expect(olderConnection(conn, heard)).toBe(older);
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
    expect(ViewItemSchema.safeParse({ kind: "user", key: "u", text: 1 }).success).toBe(false);
  });

  test("a terminal is read under terminal.read; typed into only under terminal.control", () => {
    const terminal = Object.keys(RPC_METHODS).filter((m) => m.startsWith("terminal."));
    const read = terminal.filter(
      (m) => RPC_METHODS[m as keyof typeof RPC_METHODS].capability === "terminal.read",
    );
    expect(read).toEqual([
      "terminal.read",
      "terminal.watch",
      "terminal.unwatch",
      "terminal.wait",
      "terminal.shells",
    ]);
    expect(RPC_METHODS["terminal.answer"].capability).toBe("chat.control");
    for (const m of terminal.filter((m) => !read.includes(m) && m !== "terminal.answer")) {
      expect(RPC_METHODS[m as keyof typeof RPC_METHODS].capability).toBe("terminal.control");
    }
    expect(RPC_METHODS["terminal.input"].capability).toBe("terminal.control");
  });

  test("terminal.open may name the profile whose environment its shell gets (0.13.1)", () => {
    const params = RPC_METHODS["terminal.open"].params;
    expect(
      params.parse({ workspaceId: "w", command: "codex login", profile: "codex-ab12" }),
    ).toEqual({ workspaceId: "w", command: "codex login", profile: "codex-ab12" });
    expect(params.safeParse({ workspaceId: "w", profile: "" }).success).toBe(false);
    expect(params.safeParse({ workspaceId: "w", profile: "x".repeat(101) }).success).toBe(false);
    expect(params.parse({ workspaceId: "w" })).toEqual({ workspaceId: "w" });
  });

  test("the version a hello tells is the package's", async () => {
    const pkg = await Bun.file(
      new URL("../../../../packages/remote-protocol/package.json", import.meta.url),
    ).json();
    expect(SCHEMA_VERSION).toBe(pkg.version);
  });

  test("git.status preserves an optional bounded repository root across readers", () => {
    const { capability, result } = RPC_METHODS["git.status"];
    const old = { branch: "main", ahead: 0, behind: 0, files: [{ path: "app/main.ts" }] };
    expect(capability).toBe("git");
    expect(result.parse(old)).toEqual(old);
    for (const topLevel of [
      "/repo",
      "D:\\Repo",
      "\\\\server\\share\\repo",
      `/${"a".repeat(4095)}`,
    ]) {
      const next = { ...old, topLevel };
      expect(result.parse(next)).toEqual(next);
      expect(result.omit({ topLevel: true }).parse(next)).toEqual(old);
    }
    for (const topLevel of ["", null, 123, `/${"a".repeat(4096)}`]) {
      const { topLevel: discarded, ...status } = result.parse({ ...old, topLevel });
      expect(discarded).toBeUndefined();
      expect(status).toEqual(old);
    }
    expect(result.safeParse({ ...old, ahead: -1, topLevel: 123 }).success).toBe(false);
  });

  test("sessions.reorder takes a bounded list of tab IDs for a workspace", () => {
    const { capability, params, result } = RPC_METHODS["sessions.reorder"];
    expect(capability).toBe("sessions.reorder");
    expect(CAPABILITIES).toContain(capability);
    const order = { workspaceId: "w", tabIds: ["c", "a", "c", "gone"] };
    expect(params.parse(order)).toEqual(order);
    expect(params.parse({ ...order, tabIds: [] })).toEqual({ ...order, tabIds: [] });
    expect(params.safeParse({ tabIds: ["c"] }).success).toBe(false);
    expect(params.safeParse({ ...order, tabIds: [42] }).success).toBe(false);
    expect(params.safeParse({ ...order, tabIds: Array(500).fill("c") }).success).toBe(true);
    expect(params.safeParse({ ...order, tabIds: Array(501).fill("c") }).success).toBe(false);
    expect(result.parse({})).toEqual({});
  });

  const receipt = { workspaceId: "w", tabId: "t", upTo: 123 };
  test.each([
    ["one entry", [receipt], true],
    ["the maximum", Array(MAX_MARK_SEEN).fill(receipt), true],
    ["no entries", [], false],
    ["over the maximum", Array(MAX_MARK_SEEN + 1).fill(receipt), false],
    ["missing upTo", [{ workspaceId: "w", tabId: "t" }], false],
    ["string upTo", [{ ...receipt, upTo: "123" }], false],
    ["nonfinite upTo", [{ ...receipt, upTo: Infinity }], false],
  ])("sessions.markSeen validates %s", (_label, seen, valid) => {
    expect(RPC_METHODS["sessions.markSeen"].params.safeParse({ seen }).success).toBe(valid);
  });

  test("sessions.markSeen has a capability and can mark zero results", () => {
    const { capability, result } = RPC_METHODS["sessions.markSeen"];
    expect(capability).toBe("sessions.markSeen");
    expect(CAPABILITIES).toContain(capability);
    expect(MAX_MARK_SEEN).toBe(500);
    expect(result.parse({ marked: 0 })).toEqual({ marked: 0 });
  });

  test("system.stats tells a workspace's host's CPU and memory, and takes no agent sender", () => {
    const { capability, params, result } = RPC_METHODS["system.stats"];
    expect(capability).toBe("system.stats");
    expect(CAPABILITIES).toContain(capability);
    expect(params.parse({ workspaceId: "w" })).toEqual({ workspaceId: "w" });
    expect(params.safeParse({}).success).toBe(false);
    const from = { workspaceId: "w2", tabId: "t", kind: "tab" };
    expect(params.parse({ workspaceId: "w", from })).toEqual({ workspaceId: "w" });
    const stats = { cpu: 12.5, memUsed: 1024, memTotal: 4096 };
    expect(result.parse(stats)).toEqual(stats);
    expect(result.parse({ ...stats, cpu: null })).toEqual({ ...stats, cpu: null });
    for (const wrong of [
      { ...stats, cpu: 101 },
      { ...stats, cpu: -1 },
      { ...stats, memUsed: -1 },
      { ...stats, memTotal: 0 },
      { cpu: 1, memUsed: 1 },
    ]) {
      expect(result.safeParse(wrong).success).toBe(false);
    }
  });

  const peekTurn = {
    user: { text: "Fix the relay timeout", images: 0 },
    reply: "Done: a ping every 15 s.",
    tools: { Bash: 2, Edit: 1 },
  };
  const peek = { status: { running: false, phase: "ready" }, turns: [peekTurn] };
  const tools = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, 1]));
  test.each([
    ["no turns named", {}, true],
    ["one turn", { turns: 1 }, true],
    ["the most turns", { turns: MAX_PEEK_TURNS }, true],
    ["no turns", { turns: 0 }, false],
    ["more than the most turns", { turns: MAX_PEEK_TURNS + 1 }, false],
    ["part of a turn", { turns: 1.5 }, false],
    ["turns as text", { turns: "3" }, false],
    ["an agent's read", { from: { kind: "tab", workspaceId: "w2", tabId: "t2" } }, true],
  ])("chat.peek asks for %s", (_label, more, valid) => {
    const params = { workspaceId: "w", tabId: "t", ...more };
    expect(RPC_METHODS["chat.peek"].params.safeParse(params).success).toBe(valid);
  });
  test.each([
    ["a turn", peek, true],
    ["no turns", { ...peek, turns: [] }, true],
    [
      "earlier turns, files and other tools",
      {
        ...peek,
        more: true,
        turns: [{ ...peekTurn, user: { ...peekTurn.user, files: 2 }, otherTools: 3 }],
      },
      true,
    ],
    [
      "a reply being written and a permission waiting",
      {
        status: { running: true, streaming: "…the heartbeat" },
        turns: [],
        waiting: { kind: "permission", tool: "Bash" },
      },
      true,
    ],
    [
      "another sender's message",
      { ...peek, turns: [{ received: { from: "Lead", text: "Go" }, reply: "", tools: {} }] },
      true,
    ],
    [
      "what came before the first message",
      { ...peek, turns: [{ reply: "Done", tools: {} }] },
      true,
    ],
    ["a host not connected", { ...peek, turns: [], unavailable: "offline" }, true],
    ["no history", { ...peek, turns: [], unavailable: "missing" }, true],
    ["another reason", { ...peek, turns: [], unavailable: "closed" }, false],
    ["the most turns", { ...peek, turns: Array(MAX_PEEK_TURNS).fill(peekTurn) }, true],
    [
      "more than the most turns",
      { ...peek, turns: Array(MAX_PEEK_TURNS + 1).fill(peekTurn) },
      false,
    ],
    ["more: false", { ...peek, more: false }, false],
    [
      "a user text at its limit in emoji",
      { ...peek, turns: [{ ...peekTurn, user: { text: "😀".repeat(1000), images: 0 } }] },
      true,
    ],
    [
      "a user text over its limit",
      { ...peek, turns: [{ ...peekTurn, user: { text: "a".repeat(1001), images: 0 } }] },
      false,
    ],
    ["a reply at its limit", { ...peek, turns: [{ ...peekTurn, reply: "가".repeat(2000) }] }, true],
    [
      "a reply over its limit",
      { ...peek, turns: [{ ...peekTurn, reply: "a".repeat(2001) }] },
      false,
    ],
    [
      "a received text over its limit",
      {
        ...peek,
        turns: [{ received: { from: "Lead", text: "a".repeat(301) }, reply: "", tools: {} }],
      },
      false,
    ],
    [
      "a reply being written over its limit",
      { ...peek, status: { running: true, streaming: "a".repeat(1001) } },
      false,
    ],
    [
      "no files counted as 0",
      { ...peek, turns: [{ ...peekTurn, user: { text: "", images: 0, files: 0 } }] },
      false,
    ],
    ["the most tools", { ...peek, turns: [{ ...peekTurn, tools: tools(8) }] }, true],
    ["more than the most tools", { ...peek, turns: [{ ...peekTurn, tools: tools(9) }] }, false],
    [
      "a tool name over its limit",
      { ...peek, turns: [{ ...peekTurn, tools: { ["x".repeat(65)]: 1 } }] },
      false,
    ],
    ["a tool called no times", { ...peek, turns: [{ ...peekTurn, tools: { Bash: 0 } }] }, false],
    ["other tools as 0", { ...peek, turns: [{ ...peekTurn, otherTools: 0 }] }, false],
  ])("chat.peek answers with %s", (_label, answer, valid) => {
    expect(RPC_METHODS["chat.peek"].result.safeParse(answer).success).toBe(valid);
  });

  test("chat.peek has its own capability, which a hello tells; what an open chat waits on may be left out", () => {
    const { capability, result } = RPC_METHODS["chat.peek"];
    expect(capability).toBe("chat.peek");
    expect(CAPABILITIES).toContain(capability);
    expect(MAX_PEEK_BYTES).toBe(14 * 1024);
    const parsed = result.parse({ ...peek, waiting: { kind: "review", tool: "Bash" } });
    expect(parsed.waiting).toBeUndefined();
    expect(parsed.turns).toEqual([peekTurn]);
    const from = { kind: "tab", workspaceId: "w2", tabId: "t2" } as const;
    expect(RPC_METHODS["chat.peek"].params.parse({ workspaceId: "w", tabId: "t", from })).toEqual({
      workspaceId: "w",
      tabId: "t",
      from,
    });
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
    const instructionEdit = {
      layer: { kind: "profile", agent: "claude", name: "default", id: "claude-default" },
      clear: true,
    };
    const instruction = result.parse({
      workspaces: [],
      sessions: [],
      consents: [{ ...consent, change: { kind: "instructionsEdit", instructionEdit } }],
    });
    expect(instruction.consents?.[0]?.change.instructionEdit).toEqual(instructionEdit);
    expect(
      result.safeParse({
        workspaces: [],
        sessions: [],
        consents: [{ ...consent, change: { kind: "somethingNew" } }],
      }).success,
    ).toBe(true);
    expect(result.parse({ workspaces: [], sessions: [] }).consents).toBeUndefined();
  });

  test("a consent prompt without a time limit says so; one with a limit and an older reader leave it out", () => {
    const consent = {
      id: "c1",
      at: 1000,
      expiresAt: 1000 + 24 * 60 * 60_000,
      expiresInMs: 24 * 60 * 60_000,
      from: { workspaceId: "w9", tabId: "t9" },
      workspaceId: "w1",
      change: { kind: "terminalInput" },
      eachTime: false,
      answerable: true,
    };
    expect(RemoteConsentSchema.parse({ ...consent, untimed: true }).untimed).toBe(true);
    expect(RemoteConsentSchema.parse(consent).untimed).toBeUndefined();
    expect(RemoteConsentSchema.safeParse({ ...consent, untimed: false }).success).toBe(false);
    const { untimed: _, ...olderShape } = RemoteConsentSchema.shape;
    const older = z.object(olderShape);
    expect(older.parse({ ...consent, untimed: true })).toEqual(consent);
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

  test("a failed session round-trips and readers on either schema keep its state", () => {
    const before = { workspaceId: "w", tabId: "t", kind: "codex", title: "Review", state: "idle" };
    const failed = { ...before, failed: true };
    const result = RPC_METHODS["sessions.list"].result;
    const wire = JSON.parse(JSON.stringify(result.parse({ workspaces: [], sessions: [failed] })));
    expect(result.parse(wire).sessions).toEqual([failed]);
    expect(RemoteSessionSchema.omit({ failed: true }).parse(wire.sessions[0])).toEqual(before);
    expect(result.parse({ workspaces: [], sessions: [before] }).sessions).toEqual([before]);
    expect(RemoteSessionSchema.safeParse({ ...before, failed: false }).success).toBe(false);
  });

  test("opener metadata is additive on lists and watches and invalid metadata leaves the session", () => {
    const row = { workspaceId: "w", tabId: "t", kind: "codex", title: "Review", state: "idle" };
    const openedBy = {
      workspaceId: "p",
      tabId: "opener",
      kind: "terminal",
      agent: "claude",
      name: "Prepare release",
      device: { id: "d", name: "Studio" },
    };
    const list = RPC_METHODS["sessions.list"].result;
    const watch = RPC_METHODS["sessions.watch"].result;
    const wire = JSON.parse(
      JSON.stringify({ workspaces: [], sessions: [row, { ...row, openedBy }] }),
    );
    expect(list.parse(wire).sessions).toEqual([row, { ...row, openedBy }]);
    expect(watch.parse({ ...wire, watchId: "w1" }).sessions).toEqual([row, { ...row, openedBy }]);
    expect(LegacySessionsList.parse(wire).sessions).toEqual([row, row]);
    expect(LegacySessionsWatch.parse({ ...wire, watchId: "w1" }).sessions).toEqual([row, row]);
    for (const invalid of [
      null,
      "opener",
      { ...openedBy, workspaceId: "w".repeat(65) },
      { ...openedBy, tabId: "t".repeat(65) },
      { ...openedBy, name: "a".repeat(121) },
      { ...openedBy, device: { id: "d".repeat(65), name: "Studio" } },
      { ...openedBy, device: { id: "d", name: "a".repeat(121) } },
    ]) {
      const sessions = list.parse({
        workspaces: [],
        sessions: [{ ...row, openedBy: invalid }],
      }).sessions;
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject(row);
      expect(sessions[0]?.openedBy).toBeUndefined();
    }
    const reference = { workspaceId: "p", tabId: "opener", device: { id: "d" } };
    expect(RemoteSessionSchema.parse({ ...row, openedBy: reference }).openedBy).toEqual(reference);
    const result = RemoteSessionSchema.parse({
      ...row,
      openedBy: { ...openedBy, kind: "unknown", agent: "unknown" },
    });
    expect(result.openedBy).toMatchObject({ tabId: openedBy.tabId, name: openedBy.name });
    expect(result.openedBy?.kind).toBeUndefined();
    expect(result.openedBy?.agent).toBeUndefined();
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

  test("files.read accepts opt-in validators and legacy unversioned responses", () => {
    const read = RPC_METHODS["files.read"];
    const params = { workspaceId: "w", path: "a.pdf", as: "bytes", offset: 0 } as const;
    const version = "opaque-revision";
    expect(read.params.parse({ ...params, versioned: true, length: 0 })).toEqual({
      ...params,
      versioned: true,
      length: 0,
    });
    expect(read.params.parse({ ...params, requireVersion: version }).requireVersion).toBe(version);
    expect(read.result.parse({ kind: "notModified", version })).toEqual({
      kind: "notModified",
      version,
    });
    const bytes = { kind: "bytes", path: "/w/a.pdf", data: "", offset: 0, size: 5 };
    expect(read.result.parse(bytes)).toEqual(bytes);
    expect(read.result.parse({ ...bytes, version })).toEqual({ ...bytes, version });
  });

  test("chat.image may be asked for a thumbnail, its longer side in pixels", () => {
    const image = RPC_METHODS["chat.image"];
    const ask = (more: object) =>
      image.params.safeParse({
        workspaceId: "w",
        tabId: "t",
        ref: { kind: "tool", toolUseId: "tu1", index: 0 },
        ...more,
      }).success;
    expect(ask({})).toBe(true);
    expect(ask({ maxEdge: 320 })).toBe(true);
    expect(ask({ maxEdge: MAX_IMAGE_EDGE + 1 })).toBe(false);
    expect(ask({ maxEdge: 0 })).toBe(false);
    expect(ask({ maxEdge: 1.5 })).toBe(false);
  });

  test("a chat's panel may carry the plan's usage limits, of kinds this version may not know", () => {
    const panel = {
      todos: [],
      tasks: [],
      agents: [],
      changedFiles: [],
      context: null,
      goal: null,
    };
    expect(ChatPanelSchema.safeParse(panel).success).toBe(true);
    const limits = [
      { kind: "session", percent: 65, resetsAt: 1_763_200_000_000 },
      { kind: "window", windowMins: 300, percent: 30 },
      { kind: "monthly", percent: 1 },
    ];
    expect(ChatPanelSchema.parse({ ...panel, planLimits: limits }).planLimits).toEqual(limits);
    expect(ChatPanelSchema.safeParse({ ...panel, planLimits: [{ kind: "session" }] }).success).toBe(
      false,
    );
  });

  test("a chat's status tells how its last turn failed, by kind, status and time only (0.32.0)", () => {
    const failure = { kind: "transient", status: 529, at: 1_763_200_000_000 };
    const page = (more: Record<string, unknown>) =>
      ChatPageSchema.parse({
        status: { ...status, ...more },
        start: 0,
        total: 0,
        items: [],
        tools: {},
        tasks: {},
        agentItems: {},
      }).status;
    expect(page({ failure }).failure).toEqual(failure);
    expect(page({ failure: { kind: "auth" } }).failure).toEqual({ kind: "auth" });
    expect(page({ failure: { ...failure, message: "API Error" } }).failure).toEqual(failure);
    expect(page({ failure: { kind: "later" } })).toEqual(status);
    expect(page({ failure: { kind: "request", status: 400.5 } })).toEqual(status);
    expect(page({ failure: "boom" })).toEqual(status);
    expect(TURN_FAILURE_KINDS).toEqual(["usage_limit", "transient", "auth", "request", "other"]);
  });

  test("a chat's panel names the terminal tab running its session too (0.32.0)", () => {
    const panel = {
      todos: [],
      tasks: [],
      agents: [],
      changedFiles: [],
      context: null,
      goal: null,
    };
    expect(ChatPanelSchema.parse({ ...panel, twin: { tabId: "t1" } }).twin).toEqual({
      tabId: "t1",
    });
    expect(ChatPanelSchema.parse({ ...panel, twin: { tabId: "x".repeat(65) } })).toEqual(panel);
    expect(ChatPanelSchema.parse({ ...panel, twin: "t1" })).toEqual(panel);
  });

  test("a chat's changed file carries its original spelling where a 0.34.0 host sends it", () => {
    const panel = {
      todos: [],
      tasks: [],
      agents: [],
      context: null,
      goal: null,
    };
    const file = { path: "//server/share/x.ts", added: 1, removed: 0 };
    const unc = "\\\\server\\share\\x.ts";
    expect(
      ChatPanelSchema.parse({ ...panel, changedFiles: [{ ...file, rawPath: unc }] }).changedFiles,
    ).toEqual([{ ...file, rawPath: unc }]);
    expect(ChatPanelSchema.parse({ ...panel, changedFiles: [file] }).changedFiles).toEqual([file]);
    expect(
      ChatPanelSchema.parse({ ...panel, changedFiles: [{ ...file, rawPath: 7 }] }).changedFiles,
    ).toEqual([file]);
  });

  test("a chat's panel and session tell when its app goes on after the usage limit (0.19.0)", () => {
    const panel = {
      todos: [],
      tasks: [],
      agents: [],
      changedFiles: [],
      context: null,
      goal: null,
    };
    const resume = { state: "waiting", at: 1_763_200_060_000, resetsAt: 1_763_200_000_000 };
    expect(ChatPanelSchema.parse({ ...panel, limitResume: resume }).limitResume).toEqual(resume);
    expect(ChatPanelSchema.parse({ ...panel, limitResume: { at: "soon" } })).toEqual(panel);
    const session = {
      workspaceId: "w",
      tabId: "a",
      kind: "claude",
      title: "chat",
      state: "idle",
    };
    const list = RPC_METHODS["sessions.list"].result.parse({
      workspaces: [{ id: "w", name: "ws", path: "/w" }],
      sessions: [
        { ...session, limitWait: { at: 5 } },
        { ...session, tabId: "b", limitWait: { at: "soon" } },
      ],
    });
    expect(list.sessions.map((s) => s.limitWait)).toEqual([{ at: 5 }, undefined]);
    expect(list.sessions.map((s) => s.tabId)).toEqual(["a", "b"]);
  });

  test("a session list leaves out what a newer version adds that this one cannot read", () => {
    const agent = (id: string, state = "running") => ({
      id,
      kind: "subagent",
      type: "Explore",
      state,
      start: 1,
    });
    const session = (tabId: string, more: object = {}) => ({
      workspaceId: "w",
      tabId,
      kind: "claude",
      title: "chat",
      state: "running",
      ...more,
    });
    const consent = (id: string, more: object = {}) => ({
      id,
      at: 1,
      expiresAt: 2,
      expiresInMs: 1,
      from: { workspaceId: "w", tabId: "t" },
      workspaceId: "w",
      change: { kind: "chatInput" },
      eachTime: false,
      answerable: true,
      ...more,
    });
    const list = RPC_METHODS["sessions.list"].result.parse({
      workspaces: [{ id: "w", name: "ws", path: "/w" }],
      sessions: [
        session("a", { agents: [agent("1"), agent("2", "paused"), agent("3")] }),
        session("b", { state: "sleeping" }),
        session("c", { kind: "browser" }),
        session("e", { state: "needs-you", waiting: { kind: "survey", text: "Pick one" } }),
        session("d", {
          agents: Array.from({ length: MAX_SESSION_AGENTS + 3 }, (_, i) => agent(`x${i}`)),
        }),
      ],
      consents: [consent("k1"), consent("k2", { eachTime: "maybe" })],
    });
    expect(list.sessions.map((s) => s.tabId)).toEqual(["a", "e", "d"]);
    expect(list.sessions[0]?.agents?.map((a) => a.id)).toEqual(["1", "3"]);
    expect(list.sessions[1]).toMatchObject({ state: "needs-you" });
    expect(list.sessions[1]?.waiting).toBeUndefined();
    expect(list.sessions[2]?.agents).toHaveLength(MAX_SESSION_AGENTS);
    expect(list.consents?.map((c) => c.id)).toEqual(["k1"]);
    const event = (seq: number, kind: string) => ({
      seq,
      at: 1,
      workspaceId: "w",
      tabId: "t",
      title: "x",
      kind,
      from: null,
      to: "running",
    });
    const events = RPC_METHODS["events.read"].result.parse({
      events: [event(1, "claude"), event(2, "browser"), event(3, "terminal")],
      cursor: 3,
      more: false,
    });
    expect(events.events.map((e) => e.seq)).toEqual([1, 3]);
    expect(
      RPC_METHODS["sessions.list"].result.safeParse({ workspaces: [], sessions: "none" }).success,
    ).toBe(false);
  });

  test("a chat moves to another profile only by the user, going on with its conversation or not", () => {
    const spec = RPC_METHODS["chat.profile"];
    expect(spec.capability).toBe("chat.control");
    const tab = { workspaceId: "w", tabId: "t" };
    expect(spec.params.safeParse({ ...tab, profile: "Work" }).success).toBe(true);
    expect(spec.params.safeParse({ ...tab, profile: "Work", fresh: true }).success).toBe(true);
    expect(spec.params.safeParse({ ...tab, profile: "" }).success).toBe(false);
    expect(spec.params.safeParse(tab).success).toBe(false);
    const fromAgent = spec.params.safeParse({ ...tab, profile: "Work", from: { title: "x" } });
    expect(fromAgent.success && "from" in fromAgent.data).toBe(false);
    expect(spec.result.safeParse({ from: "Personal", to: "Work" }).success).toBe(true);
  });

  test("a file goes up in pieces of at most a chunk, of at most MAX_UPLOAD_BYTES", () => {
    const begin = RPC_METHODS["chat.upload.begin"].params;
    const file = { workspaceId: "w", tabId: "t", name: "report.pdf", size: 1024 };
    expect(begin.safeParse(file).success).toBe(true);
    expect(begin.safeParse({ ...file, mediaType: "application/pdf" }).success).toBe(true);
    expect(begin.safeParse({ ...file, size: MAX_UPLOAD_BYTES + 1 }).success).toBe(false);
    expect(begin.safeParse({ ...file, size: 0 }).success).toBe(false);
    expect(begin.safeParse({ ...file, name: "" }).success).toBe(false);
    const chunk = RPC_METHODS["chat.upload.chunk"].params;
    const piece = (bytes: number) => Buffer.alloc(bytes).toString("base64");
    expect(
      chunk.safeParse({ uploadId: "u", offset: 0, data: piece(MAX_BYTES_CHUNK) }).success,
    ).toBe(true);
    expect(
      chunk.safeParse({ uploadId: "u", offset: 0, data: piece(MAX_BYTES_CHUNK + 3) }).success,
    ).toBe(false);
    expect(chunk.safeParse({ uploadId: "u", offset: -1, data: piece(1) }).success).toBe(false);
    expect(RPC_METHODS["chat.upload.end"].result.safeParse({ attachmentId: "a" }).success).toBe(
      true,
    );
    for (const name of ["chat.upload.begin", "chat.upload.chunk", "chat.upload.end"] as const) {
      expect(RPC_METHODS[name].capability).toBe("chat.control");
    }
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
    const verifier = "A".repeat(43);
    expect(KeyBundlePutSchema.parse({ bundle, expected: null, verifier }).expected).toBeNull();
    expect(KeyBundlePutSchema.safeParse({ bundle, expected: null }).success).toBe(false);
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
      { t: "error", code: "provider-error", message: "x", transcribeToken: "tt_2" },
      { t: "error", code: "provider-error", message: "x" },
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

describe("push notifications", () => {
  test("a phone registers its APNs token and notification kinds", () => {
    const registration = {
      service: "apns",
      token: "a0".repeat(16),
      environment: "sandbox",
      locale: "ko",
      kinds: ["consent", "request"],
    };
    expect(PushRegistrationSchema.parse(registration)).toEqual(registration);
    expect(
      PushRegistrationSchema.safeParse({ ...registration, token: "A0".repeat(16) }).success,
    ).toBe(false);
    expect(PushRegistrationSchema.safeParse({ ...registration, kinds: [] }).success).toBe(false);
  });

  test("a computer sends one event with a relative TTL and up to 20 recipients", () => {
    const send = { id: "AbCdEf0123456789_-wxyz", kind: "consent", ttl: 85, to: ["dev-a"] };
    expect(PushSendSchema.parse(send)).toEqual(send);
    const all = { id: send.id, kind: send.kind, ttl: 1 };
    expect(PushSendSchema.parse(all)).toEqual(all);
    expect(PushSendSchema.parse({ ...send, ttl: 1801 }).ttl).toBe(1801);
    expect(PushSendSchema.safeParse({ ...send, ttl: 1.5 }).success).toBe(false);
    for (const id of ["too-short", "A".repeat(44), `${send.id}=`]) {
      expect(PushSendSchema.safeParse({ ...send, id }).success).toBe(false);
    }
    expect(PushSendSchema.safeParse({ ...send, to: [] }).success).toBe(false);
    expect(PushSendSchema.safeParse({ ...send, to: [""] }).success).toBe(false);
    const recipients = Array.from({ length: 21 }, (_, index) => `dev-${index}`);
    expect(PushSendSchema.safeParse({ ...send, to: recipients.slice(0, 20) }).success).toBe(true);
    expect(PushSendSchema.safeParse({ ...send, to: recipients }).success).toBe(false);
  });

  test("a send returns counts or reports a duplicate event", () => {
    const counts = { sent: 1, skipped: 2, reasons: { no_registration: 1, another_reason: 1 } };
    expect(PushSendResultSchema.parse(counts)).toEqual(counts);
    expect(PushSendResultSchema.parse({ sent: 1, skipped: 0 })).toEqual({ sent: 1, skipped: 0 });
    expect(PushSendResultSchema.parse({ duplicate: true })).toEqual({ duplicate: true });
    expect(PushSendResultSchema.safeParse({ duplicate: false }).success).toBe(false);
  });

  test("a notification's app data names its version and kind", () => {
    expect(PUSH_VERSION).toBe(1);
    expect(CAPABILITIES).toContain("push");
    expect(PushPayloadSchema.parse({ v: 1, k: "result" })).toEqual({ v: 1, k: "result" });
    expect(PushPayloadSchema.safeParse({ v: 2, k: "consent" }).success).toBe(false);
  });

  test("server info keeps push absent, unavailable, or advertised", () => {
    const older = { signIn: ["apple"], relay: { version: 2 }, voice: null };
    expect(ServerInfoSchema.parse(older)).toEqual(older);
    const unavailable = { ...older, push: null };
    expect(ServerInfoSchema.parse(unavailable)).toEqual(unavailable);
    const supported = {
      ...older,
      push: { version: PUSH_VERSION, environments: ["production", "sandbox", "future"] },
    };
    expect(ServerInfoSchema.parse(supported)).toEqual(supported);
  });
});

test("expanded CLI peers share the v2 envelope and strip private transcript data", () => {
  const hello = {
    type: "hello",
    protocol: 2,
    schema: SCHEMA_VERSION,
    device: { id: "dev-a", name: "Mac", platform: "darwin" },
    serves: ["sessions", "agents.cli", "settings.instructions"],
    app: { name: "nexus-code", version: "0.36.0" },
    reply: true,
  };
  expect(SealedMessageSchema.parse(hello)).toMatchObject(hello);
  expect(
    SealedMessageSchema.parse({ ...hello, schema: "0.15.0", serves: ["sessions", "agents.cli"] }),
  ).toMatchObject({ protocol: 2, schema: "0.15.0", serves: ["sessions", "agents.cli"] });
  expect(
    SealedMessageSchema.parse({ ...hello, schema: "0.14.0", serves: ["sessions"] }),
  ).toMatchObject({
    protocol: 2,
    schema: "0.14.0",
  });
  const line = {
    id: "1:2:1",
    startMs: 1,
    endMs: 2,
    speaker: "s1",
    speakerLabel: "Speaker 1",
    speakerName: null,
    text: "hello",
  };
  const result = RPC_METHODS["notes.transcript"].result.parse({
    id: "note",
    title: "Meeting",
    recordings: [
      {
        id: "rec",
        startedAt: 10,
        participants: "auto",
        lines: [{ ...line, embedding: [0.2], score: 0.9 }],
      },
    ],
  });
  expect(result.recordings[0]?.lines).toEqual([line]);
});

test("a host drops note keys it does not know, so 0.31.0 keys go only to 0.31.0 hosts", () => {
  expect(NOTE_PAGES_SCHEMA).toBe("0.31.0");
  const read = RPC_METHODS["notes.read"].params.parse({
    workspaceId: "w",
    note: "n",
    withoutTranscript: true,
    markdownStart: 0,
    markdownLimit: 10,
    laterKey: 1,
  });
  expect(read).toEqual({
    workspaceId: "w",
    note: "n",
    withoutTranscript: true,
    markdownStart: 0,
    markdownLimit: 10,
  });
  const page = RPC_METHODS["notes.transcript"].params.parse({
    workspaceId: "w",
    note: "n",
    recording: "r",
    start: 0,
    limit: 10,
    laterKey: 1,
  });
  expect(page).toEqual({ workspaceId: "w", note: "n", recording: "r", start: 0, limit: 10 });
  expect(
    RPC_METHODS["notes.read"].result.parse({
      id: "n",
      title: "",
      updatedAt: 1,
      markdown: "",
      transcript: "",
    }),
  ).not.toContainAnyKeys(["recordings", "markdownStart", "markdownTotal"]);
  expect(
    RPC_METHODS["notes.list"].result.parse({ notes: [{ id: "n", title: "", updatedAt: 1 }] })
      .notes[0],
  ).not.toHaveProperty("recordings");
});

test("a transcript's revisions come where a 0.33.0 host sends them and drop alone when bad", () => {
  const recording = { id: "r", startedAt: 1, participants: "auto", lines: [] };
  const transcript = RPC_METHODS["notes.transcript"].result;
  expect(
    transcript.parse({
      id: "n",
      title: "",
      recordings: [{ ...recording, start: 0, total: 0, base: "aa", revision: "bb" }],
    }).recordings[0],
  ).toMatchObject({ base: "aa", revision: "bb" });
  const odd = transcript.parse({
    id: "n",
    title: "",
    recordings: [{ ...recording, base: "x".repeat(65), revision: 7 }],
  }).recordings[0];
  expect(odd).toEqual(recording);
  expect(transcript.parse({ id: "n", title: "", recordings: [recording] }).recordings[0]).toEqual(
    recording,
  );
  const info = { id: "r", startedAt: 1, ms: 0, lines: 0, participants: 2 };
  expect(NoteRecordingInfoSchema.parse({ ...info, revision: "cc" })).toEqual({
    ...info,
    revision: "cc",
  });
  expect(NoteRecordingInfoSchema.parse({ ...info, revision: "" })).toEqual(info);
  expect(NoteRecordingInfoSchema.parse(info)).toEqual(info);
});

test("peer view changes take a declared action and validated arguments", () => {
  const params = RPC_METHODS["agentView.change"].params;
  expect(
    params.parse({
      workspaceId: "w",
      change: { op: "place", tab: { key: "peer:d:t" }, show: true },
      from: { kind: "tab", workspaceId: "source", tabId: "t" },
    }).change,
  ).toEqual({ op: "place", tab: { key: "peer:d:t" }, show: true });
  for (const change of [
    { op: "settings.set", key: "cliCrossWorkspace", value: "allow" },
    { op: "place", tab: { key: "peer:d:t" }, show: true, index: -1 },
    { op: "ratios", ratios: [{ splitId: "s", ratio: 2 }] },
  ]) {
    expect(
      params.safeParse({
        workspaceId: "w",
        change,
        from: { kind: "tab", workspaceId: "source", tabId: "t" },
      }).success,
    ).toBe(false);
  }
});

test("peer profile instruction reads and writes carry a valid profile id", () => {
  const set = RPC_METHODS["settings.instructions.set"].params;
  const from = { kind: "tab", workspaceId: "source", tabId: "t" };
  const write = { workspaceId: "w", layer: "profile", text: "prompt", from };
  expect(set.safeParse(write).success).toBe(false);
  expect(set.safeParse({ ...write, profileId: "" }).success).toBe(false);
  expect(set.parse({ ...write, profileId: "codex-default" })).toEqual({
    ...write,
    profileId: "codex-default",
  });
  const read = { workspaceId: "w", agent: "codex", from, profileId: "codex-default" };
  expect(RPC_METHODS["settings.instructions"].params.parse(read)).toEqual(read);
});

test("chat instruction reads accept older replies and the same persistent layers as settings", () => {
  const chat = RPC_METHODS["chat.instructions"].result;
  const settings = RPC_METHODS["settings.instructions"].result;
  const legacy = { instructions: "Combined text" };
  expect(chat.parse(legacy)).toEqual(legacy);

  const layers = [
    { scope: { kind: "all" }, title: "All agents", text: "" },
    { scope: { kind: "agent", agent: "claude" }, title: "Claude", text: "Agent rules" },
    { scope: { kind: "profile", id: "work" }, title: "Profile: Work", text: "" },
    { scope: { kind: "workspace", id: "w" }, title: "Workspace: Parent", text: "Parent rules" },
  ];
  expect(settings.parse({ ...legacy, layers })).toEqual({ ...legacy, layers });
  expect(chat.parse({ ...legacy, session: "", layers })).toEqual({
    ...legacy,
    session: "",
    layers,
  });
  expect(
    chat.safeParse({ ...legacy, session: "", layers: [{ ...layers[0], scope: null }] }).success,
  ).toBe(false);
});

test("people and agents can write chat instructions up to 5,000 characters", () => {
  const { params } = RPC_METHODS["chat.instructions.set"];
  const write = { workspaceId: "w", tabId: "t", text: "r".repeat(5000) };
  const from = { kind: "tab", workspaceId: "source", tabId: "t" };
  expect(params.parse(write)).toEqual(write);
  expect(params.parse({ ...write, from })).toEqual({ ...write, from });
  expect(params.safeParse({ ...write, text: `${write.text}r` }).success).toBe(false);
  expect(params.safeParse({ ...write, from: null }).success).toBe(false);
});

test("remembered voice results expose names only", () => {
  const suggestions = RPC_METHODS["notes.voiceSuggestions.list"].result.parse({
    noteId: "note",
    recordingId: "rec",
    suggestions: [{ speaker: "s1", name: "Alex", embedding: [0.5], score: 0.98 }],
  });
  expect(suggestions.suggestions).toEqual([{ speaker: "s1", name: "Alex" }]);
});

test.each([
  ["browser.devtools", { tabId: "t" }],
  ["settings.instructions", { agent: "codex" }],
  ["settings.instructions.set", { layer: "workspace", text: "prompt" }],
  ["settings.instructions.set", { layer: "profile", profileId: "codex-default", text: "" }],
  ["notes.speakers", { note: "n", change: { op: "regroup", participants: "auto" } }],
  [
    "notes.voiceSuggestions.change",
    { note: "n", action: { op: "reject", speaker: "s", name: "Alex" } },
  ],
  ["notes.voiceNames.delete", {}],
  ["layout.change", { change: { op: "focus", groupId: "g" } }],
  ["agentView.change", { change: { op: "show", view: "agents" } }],
  ["worktree.new", { name: "work", prompt: "", show: false }],
  ["worktree.remove", { force: false, deleteBranch: false }],
] as const)("%s requires an agent sender", (method, args) => {
  const { params } = RPC_METHODS[method];
  const request = { workspaceId: "w", ...args };
  expect(params.safeParse(request).success).toBe(false);
  expect(
    params.safeParse({ ...request, from: { kind: "tab", workspaceId: "source", tabId: "t" } })
      .success,
  ).toBe(true);
});
