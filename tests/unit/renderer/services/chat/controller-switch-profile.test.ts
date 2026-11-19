/**
 * Moving a chat tab to another profile: a new conversation with it (the
 * program the old one ran stops, the tab forgets the session or thread it
 * had, and starts one with the new profile), or the same conversation gone
 * on with there, as a copy the new profile's program makes from the old
 * one's file. The real ipc client is spread under a spy, so later files
 * keep its other exports.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  type ContinuedCodexChoices,
  profileForkSettings,
} from "../../../../../src/renderer/services/chat/codex/profile-fork";
import { ipcErr } from "../../../../../src/shared/ipc/result";

// The version the app tells Codex it is.
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= "0.0.0";

const calls: { method: string; args: Record<string, unknown> }[] = [];
/** What a stopped program does to the tab's lines: none come here unless a test says. */
let onStop: (() => void) | undefined;
let stopFails = false;
/** A Codex program that comes up, answering what is sent to it as the test says. */
let codex: ((message: Record<string, unknown>) => void) | undefined;
let claudeSeq = 500;

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  // A Codex tab listens for its lines as it is made; none come here.
  ipcListen: () => () => {},
  ipcCallResult: (_channel: string, method: string, args: Record<string, unknown>) => {
    const input = args.message as { type?: string; request_id?: string } | undefined;
    if (method === "send" && input?.type === "control_request") {
      const controller = live.find((c) => c.key === `${args.workspaceId}:${args.tabId}`);
      controller?.receive({
        seq: ++claudeSeq,
        dir: "out",
        message: {
          type: "control_response",
          response: { subtype: "success", request_id: input.request_id, response: {} },
        },
      } as never);
      return Promise.resolve({ ok: true, value: undefined });
    }
    calls.push({ method, args });
    if (method === "stop") {
      if (stopFails) return Promise.resolve(ipcErr("chat.stop-failed", "stop refused"));
      onStop?.();
    }
    if (method === "send") codex?.(args.message as Record<string, unknown>);
    if (method === "stageThread") {
      return Promise.resolve({ ok: true, value: { found: args.threadId !== "gone" } });
    }
    if (method === "codexStart" && codex) {
      return Promise.resolve({
        ok: true,
        value: { ok: true, pid: 1, attached: false, version: null },
      });
    }
    if (method === "sessionFile") {
      const found = args.sessionId !== "gone";
      return Promise.resolve({
        ok: true,
        value: found
          ? { found, path: `/home/${args.profileId ?? "default"}/${args.sessionId}.jsonl` }
          : { found },
      });
    }
    if (method === "transcript") {
      return Promise.resolve({ ok: true, value: { found: false, lines: [], truncated: false } });
    }
    if (method === "start") {
      return Promise.resolve({
        ok: true,
        value: { ok: true, pid: 1, attached: false, version: null },
      });
    }
    // Codex starts only when the test scripts a destination program.
    if (method === "codexStart") {
      return Promise.resolve({
        ok: true,
        value: { ok: false, reason: "failed", message: "not here" },
      });
    }
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { ChatController } = await import(
  "../../../../../src/renderer/services/chat/claude/controller"
);
const { CodexController } = await import(
  "../../../../../src/renderer/services/chat/codex/controller"
);
const { useChatStore } = await import("../../../../../src/renderer/services/chat/store");
const { useTabsStore } = await import("../../../../../src/renderer/state/stores/tabs");

let seq = 0;
const live: (InstanceType<typeof ChatController> | InstanceType<typeof CodexController>)[] = [];

let restoreDestination: (() => void) | undefined;
afterEach(() => {
  restoreDestination?.();
  restoreDestination = undefined;
  for (const c of live.splice(0)) c.dispose();
  calls.length = 0;
  onStop = undefined;
  stopFails = false;
  codex = undefined;
});

describe("a Claude tab switched to another profile", () => {
  function claude() {
    const seen: { profile?: string; title?: string } = {};
    const c = new ChatController(
      { workspaceId: "ws-switch", tabId: `t${++seq}`, cwd: "/p", sessionId: "old" },
      {
        onProfile: (id) => {
          seen.profile = id;
        },
        onTitle: (title) => {
          seen.title = title;
        },
      },
    );
    live.push(c);
    useChatStore.getState().update(c.key, (prev) => ({
      ...prev,
      phase: "ready",
      model: {
        ...prev.model,
        process: "running",
        running: true,
        lastSeq: 7,
        items: [{ kind: "user", text: "hi", key: "u1" }],
      } as typeof prev.model,
      history: { ...prev.model, items: [{ kind: "user", text: "before", key: "u0" }] },
      queue: [{ id: "q", text: "later" }] as typeof prev.queue,
    }));
    return { c, seen };
  }

  test("stops its program and starts a new conversation with the profile", async () => {
    const { c, seen } = claude();
    await c.switchProfile("work");
    expect(calls.map((call) => call.method)).toEqual(["stop", "start"]);
    const start = calls[1]?.args ?? {};
    expect(start.profileId).toBe("work");
    expect(start.resume).toBeUndefined();
    expect(start.resetLog).toBe(true);
    expect(c.profileId).toBe("work");
    expect(c.currentSession()).toBeUndefined();
    expect(seen).toEqual({ profile: "work", title: "" });
    // What the tab showed is the old conversation's; the log goes on from where it was.
    const state = c.state;
    expect(state.history).toBeNull();
    expect(state.model.items).toEqual([]);
    expect(state.model.lastSeq).toBeGreaterThan(7);
    expect(state.queue).toEqual([]);
  });

  test("the profile it has already does nothing", async () => {
    const { c, seen } = claude();
    await c.switchProfile(c.profileId);
    expect(calls).toEqual([]);
    expect(seen).toEqual({});
  });

  test("a failed Claude stop leaves the source profile and held message", async () => {
    const { c, seen } = claude();
    stopFails = true;
    await expect(c.switchProfile("work")).rejects.toThrow("stop refused");
    expect(calls.map((call) => call.method)).toEqual(["stop"]);
    expect(c.currentSession()).toBe("old");
    expect(c.state.queue.map((item) => item.id)).toEqual(["q"]);
    expect(seen).toEqual({});
  });
});

describe("a Codex tab switched to another profile", () => {
  function codexTab() {
    const seen: { profile?: string; title?: string } = {};
    const c = new CodexController(
      { workspaceId: "ws-switch", tabId: `x${++seq}`, cwd: "/p", threadId: "old" },
      {
        onProfile: (id) => {
          seen.profile = id;
        },
        onTitle: (title) => {
          seen.title = title;
        },
      },
    );
    live.push(c);
    useChatStore.getState().update(c.key, (prev) => ({
      ...prev,
      phase: "ready",
      model: {
        ...prev.model,
        process: "running",
        lastSeq: 3,
        model: "gpt-old",
        effort: "high",
        permissionMode: "fullAccess",
        account: { email: "old@example.com" },
        items: [{ kind: "user", text: "hi", key: "u1" }],
      } as typeof prev.model,
    }));
    return { c, seen };
  }

  test("starts a new thread with the destination profile defaults", async () => {
    const { c, seen } = codexTab();
    let seq = 100;
    codex = (message) => {
      if (message.id === undefined) return;
      const result = message.method === "thread/start" ? { thread: { id: "new" } } : {};
      c.receive({ seq: ++seq, dir: "out", message: { id: message.id, result } } as never);
    };
    await c.setPermissionMode("fullAccess");
    await c.setModel("gpt-old");
    await c.setEffort("high");
    await c.switchProfile("work");
    expect(calls.map((call) => call.method).filter((method) => method !== "send")).toEqual([
      "stop",
      "codexStart",
    ]);
    expect(calls[1]?.args.profileId).toBe("work");
    expect(calls[1]?.args.resetLog).toBe(true);
    expect(c.currentThread()).toBe("new");
    expect(seen).toEqual({ profile: "work", title: "" });
    const model = c.state.model as Record<string, unknown>;
    expect(model.items).toEqual([]);
    expect(model.lastSeq as number).toBeGreaterThan(3);
    expect(model.model).toBeUndefined();
    expect(model.account).toBeUndefined();
    expect(model.permissionMode).toBeUndefined();
  });

  test("a rejected Codex destination startup leaves the source thread and queue available", async () => {
    const { c, seen } = codexTab();
    const held = { id: "draft", text: "keep this", images: [] };
    useChatStore.getState().update(c.key, (prev) => ({ ...prev, queue: [held] }));
    await expect(c.switchProfile("work")).rejects.toThrow("not here");
    expect(c.profileId).toBe("codex-default");
    expect(c.currentThread()).toBe("old");
    expect(c.state.queue).toEqual([held]);
    expect(c.state.model.items.map((item) => item.key)).toEqual(["u1"]);
    expect(seen).toEqual({});
  });
});

describe("a Claude tab's conversation gone on with in another profile", () => {
  function claude(target: { sessionId?: string; fork?: { sessionId: string; at?: string } } = {}) {
    const seen: {
      profile?: string;
      title?: string;
      target?: unknown;
      moves?: readonly { profileId: string; after: string }[];
    } = {};
    const c = new ChatController(
      {
        workspaceId: "ws-switch",
        tabId: `t${++seq}`,
        cwd: "/p",
        ...("fork" in target ? {} : { sessionId: "old" }),
        ...target,
      },
      {
        onProfile: (id) => {
          seen.profile = id;
        },
        onTitle: (title) => {
          seen.title = title;
        },
        onTarget: (t) => {
          seen.target = t;
        },
        onMoves: (moves) => {
          seen.moves = moves;
        },
      },
    );
    live.push(c);
    useChatStore.getState().update(c.key, (prev) => ({
      ...prev,
      phase: "ready",
      model: {
        ...prev.model,
        process: "running",
        running: true,
        lastSeq: 7,
        items: [
          { kind: "user", text: "hi", key: "u1", uuid: "uuid-u1" },
          { kind: "assistant", key: "a1", uuid: "uuid-a1", messageId: "msg-a1", blocks: [] },
        ],
      } as typeof prev.model,
      history: {
        ...prev.model,
        items: [{ kind: "user", text: "before", key: "u0", uuid: "uuid-u0" }],
      },
      queue: [{ id: "q", text: "later" }] as typeof prev.queue,
    }));
    return { c, seen };
  }

  test("copies the session from its file in the old profile, and keeps it in sight", async () => {
    const { c, seen } = claude();
    await c.continueInProfile("work");
    expect(calls.map((call) => call.method)).toEqual(["stop", "sessionFile", "start"]);
    expect(calls[1]?.args).toMatchObject({
      sessionId: "old",
      profileId: "claude-default",
    });
    const start = calls[2]?.args ?? {};
    expect(start.profileId).toBe("work");
    expect(start.resume).toBe("/home/claude-default/old.jsonl");
    expect(start.fork).toBe(true);
    expect(start.resetLog).toBe(true);
    expect(c.profileId).toBe("work");
    // The copy has no id of its own until it starts.
    expect(c.currentSession()).toBeUndefined();
    expect(seen.profile).toBe("work");
    expect(seen.title).toBeUndefined();
    expect(seen.target).toEqual({ fork: { sessionId: "old", profileId: "claude-default" } });
    expect(seen.moves).toEqual([{ profileId: "work", after: "uuid-a1", at: expect.any(Number) }]);
    // The conversation stays; held messages and the old program's lines go.
    const state = c.state;
    expect(state.history?.items.map((item) => item.key)).toEqual(["u0", "u1", "a1"]);
    expect(state.model.items).toEqual([]);
    expect(state.model.lastSeq).toBeGreaterThan(7);
    expect(state.queue).toEqual([]);
  });

  test("the exit of the program it stops is not part of the conversation", async () => {
    const { c } = claude();
    useChatStore.getState().update(c.key, (prev) => ({
      ...prev,
      model: {
        ...prev.model,
        items: [...prev.model.items, { kind: "notice", key: "n5", code: "exited", at: 1 }],
      },
    }));
    onStop = () =>
      useChatStore.getState().update(c.key, (prev) => ({
        ...prev,
        model: {
          ...prev.model,
          process: "exited",
          items: [...prev.model.items, { kind: "notice", key: "n8", code: "exited", at: 2 }],
        },
      }));
    await c.continueInProfile("work");
    // An exit the conversation had before stays in it.
    expect(c.state.history?.items.map((item) => item.key)).toEqual(["u0", "u1", "a1", "n5"]);
  });

  test("a copy without an id yet is copied from where it copies, up to its message", async () => {
    const { c, seen } = claude({ fork: { sessionId: "src", at: "uuid-x" } });
    await c.continueInProfile("work");
    expect(seen.target).toEqual({
      fork: { sessionId: "src", at: "uuid-x", profileId: "claude-default" },
    });
    const start = calls.find((call) => call.method === "start")?.args ?? {};
    expect(start.resume).toBe("/home/claude-default/src.jsonl");
    expect(start.resumeAt).toBe("uuid-x");
  });

  test("back in the profile that keeps the session, it is that profile's own", async () => {
    const { c } = claude();
    await c.continueInProfile("work");
    calls.length = 0;
    await c.continueInProfile("claude-default");
    const start = calls.find((call) => call.method === "start")?.args ?? {};
    // The copy the work profile made has no id yet: the old session is copied, by id.
    expect(calls.map((call) => call.method)).not.toContain("sessionFile");
    expect(start.resume).toBe("old");
    expect(start.profileId).toBeUndefined();
  });

  test("a session gone from the old profile fails the start", async () => {
    const { c } = claude({ sessionId: "gone" });
    await expect(c.continueInProfile("work")).rejects.toThrow();
    expect(calls.map((call) => call.method)).toEqual(["stop", "sessionFile"]);
    expect(c.state.phase).toBe("failed");
    expect(c.currentSession()).toBe("gone");
    expect(c.profileId).toBe("claude-default");
  });

  test("a tab with no session yet just switches", async () => {
    const c = new ChatController({ workspaceId: "ws-switch", tabId: `t${++seq}`, cwd: "/p" });
    live.push(c);
    await c.continueInProfile("work");
    const start = calls.find((call) => call.method === "start")?.args ?? {};
    expect(start.resume).toBeUndefined();
    expect(c.profileId).toBe("work");
  });

  test("a session another profile keeps, taken up from the list, is copied into the tab's", async () => {
    const seen: { profile?: string; target?: unknown } = {};
    const c = new ChatController(
      { workspaceId: "ws-switch", tabId: `t${++seq}`, cwd: "/p", profileId: "work" },
      {
        onProfile: (id) => {
          seen.profile = id;
        },
        onTarget: (t) => {
          seen.target = t;
        },
      },
    );
    live.push(c);
    await c.resumeSession("theirs", "claude-default");
    expect(seen.profile).toBeUndefined();
    expect(c.profileId).toBe("work");
    expect(seen.target).toEqual({ fork: { sessionId: "theirs", profileId: "claude-default" } });
    const transcript = calls.find((call) => call.method === "transcript")?.args ?? {};
    expect(transcript.profileId).toBe("claude-default");
    const start = calls.find((call) => call.method === "start")?.args ?? {};
    expect(start.resume).toBe("/home/claude-default/theirs.jsonl");
    expect(start.fork).toBe(true);
    expect(start.profileId).toBe("work");
  });

  test("one of the tab's own profile is gone on with as it is", async () => {
    const c = new ChatController({ workspaceId: "ws-switch", tabId: `t${++seq}`, cwd: "/p" });
    live.push(c);
    await c.resumeSession("mine", "claude-default");
    expect(calls.map((call) => call.method)).not.toContain("sessionFile");
    const start = calls.find((call) => call.method === "start")?.args ?? {};
    expect(start.resume).toBe("mine");
    expect(start.fork).toBeUndefined();
    expect(c.currentSession()).toBe("mine");
  });
});

describe("a Codex tab's thread gone on with in another profile", () => {
  const destination = {
    model: "destination",
    reasoningEffort: "medium",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "workspaceWrite", networkAccess: false, writableRoots: [] },
  };

  function resolveDestination(fail = false) {
    const spy = spyOn(CodexController, "destinationForkSettings").mockImplementation(
      async (_target, selected: ContinuedCodexChoices) => {
        if (fail) throw new Error("Destination config is invalid");
        return profileForkSettings(destination, selected, [
          { value: "destination", supportedEffortLevels: ["medium"] },
          { value: "picked", supportedEffortLevels: ["high"] },
        ]);
      },
    );
    restoreDestination = () => spy.mockRestore();
    return spy;
  }

  test("a destination resolution failure leaves the original profile and program alone", async () => {
    resolveDestination(true);
    const c = new CodexController({
      workspaceId: "ws-switch",
      tabId: `x${++seq}`,
      cwd: "/p",
      threadId: "old",
    });
    live.push(c);
    await expect(c.continueInProfile("work")).rejects.toThrow("Destination config is invalid");
    expect(c.profileId).toBe("codex-default");
    expect(calls.map((call) => call.method)).not.toContain("stop");
    expect(calls.map((call) => call.method)).not.toContain("codexStart");
  });

  test("preserves the source after a failed fork startup", async () => {
    const resolve = resolveDestination();
    const seen: { profile?: string; moves?: readonly unknown[] } = {};
    const c = new CodexController(
      { workspaceId: "ws-switch", tabId: `x${++seq}`, cwd: "/p", threadId: "old" },
      {
        onProfile: (id) => {
          seen.profile = id;
        },
        onMoves: (moves) => {
          seen.moves = moves;
        },
      },
    );
    live.push(c);
    useChatStore.getState().update(c.key, (prev) => ({
      ...prev,
      phase: "ready",
      model: {
        ...prev.model,
        process: "running",
        lastSeq: 3,
        threadName: "Named",
        permissionMode: "fullAccess",
        items: [
          { kind: "user", text: "hi", key: "u1", uuid: "item-1" },
          { kind: "assistant", key: "a1", messageId: "turn-1", blocks: [] },
        ],
      } as typeof prev.model,
    }));
    await expect(c.continueInProfile("work")).rejects.toThrow("not here");
    expect(calls.map((call) => call.method)).toEqual(["stop", "codexStart"]);
    expect(calls[1]?.args.profileId).toBe("work");
    expect(seen).toEqual({});
    expect(c.profileId).toBe("codex-default");
    expect(c.currentThread()).toBe("old");
    const model = c.state.model as Record<string, unknown>;
    expect(c.state.model.items.map((item) => item.key)).toEqual(["u1", "a1"]);
    expect(model.permissionMode).toBe("fullAccess");
    expect(resolve.mock.calls[0]?.[1]).toEqual({
      model: undefined,
      effort: undefined,
      readOnly: false,
    });
  });

  test("uses destination approval and keeps only an explicit read-only sandbox and supported picks", async () => {
    resolveDestination();
    const c = new CodexController({
      workspaceId: "ws-switch",
      tabId: `x${++seq}`,
      cwd: "/p",
      threadId: "old",
    });
    live.push(c);
    useChatStore.getState().update(c.key, (prev) => ({
      ...prev,
      phase: "ready",
      model: {
        ...prev.model,
        process: "running",
        threadName: "Named",
        items: [{ kind: "user", text: "hi", key: "u1", uuid: "item-1" }],
      } as typeof prev.model,
    }));
    let lineSeq = 100;
    const sent: Record<string, unknown>[] = [];
    codex = (message) => {
      sent.push(message);
      if (message.id === undefined) return;
      const result =
        message.method === "thread/fork"
          ? {
              ...destination,
              model: "picked",
              reasoningEffort: "high",
              sandbox: { type: "readOnly", networkAccess: false },
              thread: { id: "copy" },
            }
          : {};
      queueMicrotask(() =>
        c.receive({ seq: ++lineSeq, dir: "out", message: { id: message.id, result } } as never),
      );
    };
    await c.setPermissionMode("readOnly");
    await c.setModel("picked");
    await c.setEffort("high");
    await c.continueInProfile("work");
    await Bun.sleep(20);
    const order = calls
      .filter((call) => call.method === "stageThread" || call.method === "send")
      .map((call) =>
        call.method === "send"
          ? String((call.args.message as { method?: string }).method)
          : "stage",
      )
      .filter((step) => !/^(account|model|collaborationMode)\/|^thread\/goal/.test(step));
    // Introduced first, as ever: what the tab asks meanwhile is not refused.
    expect(order).toEqual(["initialize", "initialized", "stage", "thread/fork", "thread/name/set"]);
    const stage = calls.find((call) => call.method === "stageThread")?.args;
    expect(stage).toMatchObject({
      threadId: "old",
      fromProfileId: "codex-default",
      toProfileId: "work",
    });
    const initialize = sent.find((m) => m.method === "initialize");
    expect(initialize?.params).toMatchObject({ capabilities: { experimentalApi: true } });
    const fork = sent.find((m) => m.method === "thread/fork");
    expect(fork?.params).toMatchObject({
      threadId: "old",
      sandbox: "read-only",
      approvalPolicy: "never",
      model: "picked",
      config: { model_reasoning_effort: "high" },
      deferGoalContinuation: true,
    });
    expect((fork?.params as { path?: unknown }).path).toBeUndefined();
    expect(sent.find((m) => m.method === "thread/name/set")?.params).toEqual({
      threadId: "copy",
      name: "Named",
    });
  });

  test("refuses a fork that retains elevated source permissions", async () => {
    resolveDestination();
    const c = new CodexController({
      workspaceId: "ws-switch",
      tabId: `x${++seq}`,
      cwd: "/p",
      threadId: "old",
    });
    live.push(c);
    const sent: Record<string, unknown>[] = [];
    let lineSeq = 100;
    codex = (message) => {
      sent.push(message);
      if (message.id === undefined) return;
      const result =
        message.method === "thread/fork"
          ? {
              thread: { id: "unsafe", forkedFromId: "old" },
              approvalPolicy: "on-request",
              sandbox: { type: "dangerFullAccess" },
            }
          : {};
      queueMicrotask(() => {
        c.receive({ seq: ++lineSeq, dir: "in", message } as never);
        c.receive({ seq: ++lineSeq, dir: "out", message: { id: message.id, result } } as never);
      });
    };
    await c.setPermissionMode("fullAccess");
    await expect(c.continueInProfile("work")).rejects.toThrow("destination profile's permissions");
    expect(sent.find((m) => m.method === "thread/fork")?.params).toMatchObject({
      sandbox: "workspace-write",
      approvalPolicy: "never",
    });
    expect(sent.find((m) => m.method === "thread/delete")?.params).toEqual({ threadId: "unsafe" });
    expect(c.currentThread()).not.toBe("unsafe");
  });

  test("a thread with no turn yet has no file to fork: a new thread, nothing staged", async () => {
    const seen: { profile?: string; moves?: readonly unknown[] } = {};
    const c = new CodexController(
      { workspaceId: "ws-switch", tabId: `x${++seq}`, cwd: "/p", threadId: "fresh" },
      {
        onProfile: (id) => {
          seen.profile = id;
        },
        onMoves: (moves) => {
          seen.moves = moves;
        },
      },
    );
    live.push(c);
    useChatStore.getState().update(c.key, (prev) => ({
      ...prev,
      phase: "ready",
      model: { ...prev.model, process: "running", threadId: "fresh" } as typeof prev.model,
    }));
    let lineSeq = 100;
    const sent: Record<string, unknown>[] = [];
    codex = (message) => {
      sent.push(message);
      if (message.id === undefined) return;
      const result = message.method === "thread/start" ? { thread: { id: "new" } } : {};
      queueMicrotask(() =>
        c.receive({ seq: ++lineSeq, dir: "out", message: { id: message.id, result } } as never),
      );
    };
    await c.continueInProfile("work");
    await Bun.sleep(20);
    expect(seen.profile).toBe("work");
    expect(calls.some((call) => call.method === "stageThread")).toBe(false);
    const asked = sent
      .map((m) => String(m.method))
      .filter((m) => !/^(account|model|collaborationMode)\/|^thread\/goal|^initialized?$/.test(m));
    expect(asked).toEqual(["thread/start"]);
    expect(seen.moves).toBeUndefined();
    expect(sent.find((message) => message.method === "thread/start")?.params).toEqual({
      cwd: "/p",
    });
  });

  test("a tab not running yet, its turns not read, still forks", async () => {
    resolveDestination();
    const c = new CodexController({
      workspaceId: "ws-switch",
      tabId: `x${++seq}`,
      cwd: "/p",
      threadId: "old",
    });
    live.push(c);
    let lineSeq = 100;
    const sent: Record<string, unknown>[] = [];
    codex = (message) => {
      sent.push(message);
      if (message.id === undefined) return;
      const result =
        message.method === "thread/fork" ? { ...destination, thread: { id: "copy" } } : {};
      queueMicrotask(() =>
        c.receive({ seq: ++lineSeq, dir: "out", message: { id: message.id, result } } as never),
      );
    };
    await c.continueInProfile("work");
    await Bun.sleep(20);
    expect(sent.find((m) => m.method === "thread/fork")?.params).toMatchObject({
      threadId: "old",
    });
  });
});

describe("the tab's profile in the store", () => {
  test("another profile drops the session the old one kept", () => {
    const tab = useTabsStore.getState().createTab("ws-switch-store", {
      type: "claude",
      props: { cwd: "/p", sessionId: "old", profileId: "work" },
    });
    useTabsStore.getState().setChatProfile("ws-switch-store", tab.id, undefined);
    expect(useTabsStore.getState().byWorkspace["ws-switch-store"]?.[tab.id]?.props).toEqual({
      cwd: "/p",
    });
  });

  test("its moves go with the session it copies, and not to a new conversation", () => {
    const store = () => useTabsStore.getState();
    const tab = store().createTab("ws-switch-store", { type: "claude", props: { cwd: "/p" } });
    const move = { profileId: "work", after: "u", at: 1 };
    store().setChatProfile("ws-switch-store", tab.id, "work");
    store().setClaudeTarget("ws-switch-store", tab.id, {
      fork: { sessionId: "s", profileId: "claude-default" },
    });
    store().setChatMoves("ws-switch-store", tab.id, [move]);
    store().setClaudeSession("ws-switch-store", tab.id, "copy");
    const props = () => store().byWorkspace["ws-switch-store"]?.[tab.id]?.props;
    expect(props()).toEqual({ cwd: "/p", sessionId: "copy", profileId: "work", moves: [move] });
    store().setChatProfile("ws-switch-store", tab.id, undefined);
    expect(props()).toEqual({ cwd: "/p" });
  });

  test("and a Codex tab, its thread", () => {
    const tab = useTabsStore.getState().createTab("ws-switch-store", {
      type: "codex",
      props: { cwd: "/p", threadId: "old", fork: { threadId: "f" } },
    });
    useTabsStore.getState().setChatProfile("ws-switch-store", tab.id, "work");
    expect(useTabsStore.getState().byWorkspace["ws-switch-store"]?.[tab.id]?.props).toEqual({
      cwd: "/p",
      profileId: "work",
    });
  });
});
