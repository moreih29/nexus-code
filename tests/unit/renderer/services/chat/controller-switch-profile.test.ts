/**
 * Switching a chat tab to another profile starts it over in a new
 * conversation with that profile: the program the old one ran stops, the
 * tab forgets the session or thread it had, and starts one with the new
 * profile. The real ipc client is spread under a spy, so later files keep
 * its other exports.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

const calls: { method: string; args: Record<string, unknown> }[] = [];

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  // A Codex tab listens for its lines as it is made; none come here.
  ipcListen: () => () => {},
  ipcCallResult: (_channel: string, method: string, args: Record<string, unknown>) => {
    calls.push({ method, args });
    // A start that does not come up: nothing past it runs here.
    if (method === "start" || method === "codexStart") {
      return Promise.resolve({
        ok: true,
        value: { ok: false, reason: "failed", message: "not here" },
      });
    }
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { ChatController } = await import("../../../../../src/renderer/services/chat/controller");
const { CodexController } = await import(
  "../../../../../src/renderer/services/chat/codex-controller"
);
const { useChatStore } = await import("../../../../../src/renderer/services/chat/store");
const { useTabsStore } = await import("../../../../../src/renderer/state/stores/tabs");

let seq = 0;
const live: { dispose: () => void }[] = [];

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  calls.length = 0;
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
    expect(state.model.lastSeq).toBe(7);
    expect(state.queue).toEqual([]);
  });

  test("the profile it has already does nothing", async () => {
    const { c, seen } = claude();
    await c.switchProfile(c.profileId);
    expect(calls).toEqual([]);
    expect(seen).toEqual({});
  });
});

describe("a Codex tab switched to another profile", () => {
  function codex() {
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

  test("starts a new thread with the profile, keeping only the permission preset", async () => {
    const { c, seen } = codex();
    await c.switchProfile("work");
    expect(calls.map((call) => call.method)).toEqual(["stop", "codexStart"]);
    expect(calls[1]?.args.profileId).toBe("work");
    expect(calls[1]?.args.resetLog).toBe(true);
    expect(c.currentThread()).toBeUndefined();
    expect(seen).toEqual({ profile: "work", title: "" });
    const model = c.state.model as Record<string, unknown>;
    expect(model.items).toEqual([]);
    expect(model.lastSeq).toBe(3);
    expect(model.model).toBeUndefined();
    expect(model.account).toBeUndefined();
    expect(model.permissionMode).toBe("fullAccess");
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
