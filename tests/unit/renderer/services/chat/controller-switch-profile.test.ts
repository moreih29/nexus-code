import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  type ContinuedCodexChoices,
  profileForkSettings,
} from "../../../../../src/renderer/services/chat/codex/profile-fork";
import { ipcErr } from "../../../../../src/shared/ipc/result";
import { ClaudeTabPropsSchema, CodexTabPropsSchema } from "../../../../../src/shared/types/layout";

const calls: { method: string; args: Record<string, unknown> }[] = [];
let onStop: (() => void) | undefined;
let onStart: (() => void) | undefined;
let stopFails = false;
let codex: ((message: Record<string, unknown>) => void) | undefined;
let claudeSeq = 500;
let initializeRequest: Record<string, unknown> | undefined;

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: () => () => {},
  ipcCallResult: (_channel: string, method: string, args: Record<string, unknown>) => {
    const input = args.message as
      | {
          type?: string;
          request_id?: string;
          request?: Record<string, unknown>;
        }
      | undefined;
    if (method === "send" && input?.type === "control_request") {
      if (input.request?.subtype === "initialize") initializeRequest = input.request;
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
    if (method === "start" || method === "codexStart") onStart?.();
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
    if (method === "transcriptPage") {
      return Promise.resolve({ ok: true, value: { found: false, lines: [], truncated: false } });
    }
    if (method === "start") {
      if (args.workspaceId === "ws-instructions") {
        live
          .find((c) => c.key === `${args.workspaceId}:${args.tabId}`)
          ?.receive({
            seq: ++claudeSeq,
            dir: "sys",
            message: { event: "start" },
          });
      }
      return Promise.resolve({
        ok: true,
        value: { ok: true, pid: 1, attached: false, version: null },
      });
    }
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
  onStart = undefined;
  stopFails = false;
  initializeRequest = undefined;
  codex = undefined;
});

async function waitFor(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (ready()) return;
    await Bun.sleep(10);
  }
  throw new Error("the tab did not finish restarting");
}

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

  test("restarts a connection edit on the same session after the turn and its jobs", async () => {
    const { c } = claude();
    const setIdle = (running: boolean, jobRunning: boolean) =>
      useChatStore.getState().update(c.key, (prev) => ({
        ...prev,
        queue: [],
        model: {
          ...prev.model,
          running,
          contextUsage: { maxTokens: 1_000_000 },
          tasks: jobRunning
            ? {
                job: {
                  taskId: "job",
                  type: "local_bash",
                  description: "command",
                  status: "running",
                },
              }
            : {},
        },
      }));
    setIdle(true, true);
    c.profileConnectionChanged("different-profile");
    c.profileConnectionChanged(c.profileId);
    await Bun.sleep(20);
    expect(calls).toEqual([]);
    setIdle(false, true);
    await Bun.sleep(260);
    expect(calls).toEqual([]);
    c.profileConnectionChanged(c.profileId);
    onStart = () =>
      c.receive({
        seq: ++claudeSeq,
        dir: "sys",
        message: { event: "start", connectionChanged: true },
      });
    setIdle(false, false);
    await waitFor(
      () => calls.some(({ method }) => method === "start") && c.state.phase === "ready",
    );
    expect(calls.map(({ method }) => method)).toEqual(["stop", "start"]);
    expect(calls[1]?.args).toMatchObject({ resume: "old", connectionChanged: true });
    expect(calls[1]?.args.resetLog).toBeUndefined();
    expect(c.currentSession()).toBe("old");
    expect(c.state.history?.items).toHaveLength(1);
    expect(c.state.model.items).toContainEqual(
      expect.objectContaining({ code: "connection_restarted" }),
    );
    expect(c.state.model.contextUsage).toBeUndefined();
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

  test.each([
    false,
    true,
  ])("applies a saved connection while keeping the timeline (provider changed: %s)", async (providerChanged) => {
    const { c } = codexTab();
    let line = 100;
    const updateJobs = (running: boolean) =>
      useChatStore.getState().update(c.key, (prev) => ({
        ...prev,
        model: {
          ...prev.model,
          threadId: "old",
          tasks: running
            ? {
                job: {
                  taskId: "job",
                  type: "codex-command",
                  description: "command",
                  status: "running",
                },
              }
            : {},
        },
      }));
    updateJobs(true);
    c.profileConnectionChanged(c.profileId);
    await Bun.sleep(20);
    expect(calls).toEqual([]);
    onStart = () =>
      c.receive({ seq: ++line, dir: "sys", message: { event: "start", connectionChanged: true } });
    const destination = {
      model: "gateway",
      modelProvider: "nexus_profile",
      approvalPolicy: "never",
      sandbox: { type: "readOnly" },
    };
    codex = (message) => {
      if (message.id === undefined) return;
      c.receive({ seq: ++line, dir: "in", message });
      let result: Record<string, unknown> = {};
      switch (message.method) {
        case "config/read":
          result = { config: { model: "gateway", model_provider: "nexus_profile" } };
          break;
        case "thread/read":
          result = {
            thread: { id: "old", modelProvider: providerChanged ? "openai" : "nexus_profile" },
          };
          break;
        case "thread/start":
          result = { ...destination, thread: { id: "ephemeral" } };
          break;
        case "thread/resume":
          result = { ...destination, thread: { id: "old" } };
          break;
        case "thread/fork":
          result = { ...destination, thread: { id: "copy", forkedFromId: "old" } };
          break;
      }
      c.receive({ seq: ++line, dir: "out", message: { id: message.id, result } });
    };
    updateJobs(false);
    await waitFor(
      () => calls.some(({ method }) => method === "codexStart") && c.state.phase === "ready",
    );
    const restart = calls.find(({ method }) => method === "codexStart");
    expect(restart?.args).toMatchObject({ connectionChanged: true });
    expect(restart?.args.resetLog).toBeUndefined();
    const rpc = calls.filter(({ method }) => method === "send").map(({ args }) => args.message);
    expect(rpc).toContainEqual(
      expect.objectContaining({
        method: providerChanged ? "thread/fork" : "thread/resume",
        params: expect.objectContaining({ threadId: "old", model: "gateway", excludeTurns: true }),
      }),
    );
    expect(c.currentThread()).toBe(providerChanged ? "copy" : "old");
    expect(c.model.items).toContainEqual(expect.objectContaining({ kind: "user", text: "hi" }));
    expect(c.model.items).toContainEqual(expect.objectContaining({ code: "connection_restarted" }));
    expect(c.model.model).toBe("gateway");
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
    expect(c.currentSession()).toBeUndefined();
    expect(seen.profile).toBe("work");
    expect(seen.title).toBeUndefined();
    expect(seen.target).toEqual({ fork: { sessionId: "old", profileId: "claude-default" } });
    expect(seen.moves).toEqual([{ profileId: "work", after: "uuid-a1", at: expect.any(Number) }]);
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
    expect(initializeRequest?.systemPromptSnapshot).toBeUndefined();
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
    const transcript = calls.find((call) => call.method === "transcriptPage")?.args ?? {};
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
    expect(initializeRequest?.systemPromptSnapshot).toBe(false);
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

test("an initialized Claude tab restarts with edited instructions before its first prompt", async () => {
  const base = { workspaceId: "ws-instructions", tabId: `t${++seq}`, cwd: "/p" };
  let instructions = "";
  const c = new ChatController(base, {
    instructions: () => instructions,
    mergedInstructions: (_profile, text) => text,
  });
  live.push(c);
  await c.prepareSend();
  instructions = "First-prompt rules";
  await c.send("Review the diff.");
  instructions = "Later rules";
  await c.send("Review the tests.");
  expect(
    calls.filter(({ method }) => method === "start").map(({ args }) => args.instructions),
  ).toEqual(["", "First-prompt rules"]);
  expect(
    calls.filter(({ method }) => method === "send").map(({ args }) => args.instructions),
  ).toContain("Later rules");
});

test("Claude and Codex forks copy the session layer into the new tab's persisted props", () => {
  const base = { workspaceId: "ws-instructions-fork", cwd: "/tmp/project" };
  let instructions = "Review only";
  const hooks = { instructions: () => instructions };
  const claude = new ChatController({ ...base, tabId: "claude" }, hooks);
  const codex = new CodexController({ ...base, tabId: "codex" }, hooks);
  try {
    const claudeFork = ClaudeTabPropsSchema.parse({ cwd: base.cwd, ...claude.inherited() });
    const codexFork = CodexTabPropsSchema.parse({
      cwd: base.cwd,
      ...codex.inheritedInstructions(),
    });
    instructions = "Write tests";
    expect(claudeFork.instructions).toBe("Review only");
    expect(codexFork.instructions).toBe("Review only");
    expect(claude.inherited().instructions).toBe("Write tests");
    expect(codex.inheritedInstructions().instructions).toBe("Write tests");
  } finally {
    claude.dispose();
    codex.dispose();
  }
});
