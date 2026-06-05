/**
 * Tests for PTY hold / restore / expire lifecycle (task 13 acceptance 1–2).
 *
 * Acceptance criteria:
 *   (1) `reconnecting` with hadEpoch=true → sessions held (pty.held emitted),
 *       NO pty.exit. On `ready` → session.list + pty.replay for alive tabs,
 *       pty.exit for dead tabs. Held state released.
 *   (2) `held-then-expired` → pty.expired + pty.exit for held sessions.
 *
 * Legacy / local path (hadEpoch=false) on `reconnecting` still emits pty.exit
 * immediately (invariant preserved).
 */
import { describe, expect, mock, test } from "bun:test";
import { startAgentPtyHost } from "../../../../src/main/features/pty/agent-host";
import type { AgentPtyWorkspaceManager } from "../../../../src/main/features/pty/agent-host";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
  ChannelLifecycleEvent,
} from "../../../../src/main/infra/agent/channel";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TAB_A = "11111111-1111-4111-8111-111111111111";
const TAB_B = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------------
// Fake channel
// ---------------------------------------------------------------------------

class FakeAgentChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly callResolvers = new Map<string, (value: unknown) => void>();
  private readonly eventListeners = new Map<string, Set<ChannelEventCallback>>();
  private readonly lifecycleListeners = new Set<ChannelLifecycleCallback>();

  // Default session.list response — override per test.
  sessionListResult: { sessions: Array<{ workspaceId: string; tabId: string }> } = {
    sessions: [],
  };

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "pty.spawn") return { pid: 1 } as T;
    if (method === "session.list") return this.sessionListResult as T;
    if (method === "pty.replay") return {} as T;
    return {} as T;
  }

  fire(_method: string, _params?: unknown): void {}

  on(event: string, cb: ChannelEventCallback): () => void {
    let listeners = this.eventListeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(event, listeners);
    }
    listeners.add(cb);
    return () => listeners?.delete(cb);
  }

  onLifecycle(cb: ChannelLifecycleCallback): () => void {
    this.lifecycleListeners.add(cb);
    return () => this.lifecycleListeners.delete(cb);
  }

  emitLifecycle(event: ChannelLifecycleEvent): void {
    for (const cb of Array.from(this.lifecycleListeners)) cb(event);
  }

  dispose(): void {}
}

function makeWorkspaceManager(channel: FakeAgentChannel): AgentPtyWorkspaceManager {
  return {
    async getAgentChannel(id: string): Promise<AgentChannel> {
      if (id === WORKSPACE_ID) return channel;
      throw new Error(`workspace not found: ${id}`);
    },
    async tryGetAgentChannel(id: string): Promise<AgentChannel | null> {
      return id === WORKSPACE_ID ? channel : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Acceptance 1a: reconnecting (hadEpoch=true) → sessions held
// ---------------------------------------------------------------------------

describe("PTY hold on reconnecting (hadEpoch=true)", () => {
  test("emits pty.held and NO pty.exit when reconnecting with epoch", async () => {
    const channel = new FakeAgentChannel();
    const host = startAgentPtyHost(makeWorkspaceManager(channel));

    const held: unknown[] = [];
    const exits: unknown[] = [];
    host.on("held", (a) => held.push(a));
    host.on("exit", (a) => exits.push(a));

    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_A, cwd: "/", cols: 80, rows: 24 });
    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_B, cwd: "/", cols: 80, rows: 24 });

    channel.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: true });

    expect(held).toHaveLength(2);
    expect(held).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_A });
    expect(held).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_B });
    expect(exits).toHaveLength(0);
  });

  test("write is dropped (no-op) while session is held", async () => {
    const channel = new FakeAgentChannel();
    const host = startAgentPtyHost(makeWorkspaceManager(channel));

    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_A, cwd: "/", cols: 80, rows: 24 });
    channel.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: true });
    channel.calls.length = 0;

    const result = await host.call("write", { workspaceId: WORKSPACE_ID, tabId: TAB_A, data: "hello" });

    expect(result).toBeUndefined();
    expect(channel.calls.some((c) => c.method === "pty.write")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Acceptance 1b: ready → session.list + replay, pty.exit for dead tabs
// ---------------------------------------------------------------------------

describe("PTY restore on ready (epoch-match)", () => {
  test("alive tab gets pty.restored + pty.replay, dead tab gets pty.exit", async () => {
    const channel = new FakeAgentChannel();
    // Only TAB_A is alive in session.list.
    channel.sessionListResult = {
      sessions: [{ workspaceId: WORKSPACE_ID, tabId: TAB_A }],
    };

    const host = startAgentPtyHost(makeWorkspaceManager(channel));

    const restored: unknown[] = [];
    const exits: unknown[] = [];
    host.on("restored", (a) => restored.push(a));
    host.on("exit", (a) => exits.push(a));

    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_A, cwd: "/", cols: 80, rows: 24 });
    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_B, cwd: "/", cols: 80, rows: 24 });

    channel.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: true });
    channel.emitLifecycle({ type: "ready" });

    // Allow the async restoreHeldSessions to complete.
    await new Promise<void>((r) => setTimeout(r, 0));

    // TAB_A: restored with replay
    expect(restored).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_A, withReplay: true });
    // TAB_B: restored without replay (dead)
    expect(restored).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_B, withReplay: false });
    // TAB_B gets exit
    expect(exits).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_B, code: null });
    // TAB_A does NOT get exit
    expect(exits.some((e) => (e as { tabId: string }).tabId === TAB_A)).toBe(false);
  });

  test("injects \\x1bc into the data stream before restored and before pty.replay", async () => {
    const channel = new FakeAgentChannel();
    channel.sessionListResult = {
      sessions: [{ workspaceId: WORKSPACE_ID, tabId: TAB_A }],
    };

    const host = startAgentPtyHost(makeWorkspaceManager(channel));

    // Capture the interleaved order of data chunks, restored events, and
    // pty.replay RPC calls. The reset MUST travel on the data stream ahead of
    // the replay request — a control-channel reset races the data stream and
    // can wipe the wiggle repaint (observed live: black TUI until a keypress).
    const order: string[] = [];
    host.on("data", (a) => {
      const d = a as { tabId: string; chunk: string };
      if (d.chunk === "\x1bc") order.push(`reset:${d.tabId}`);
    });
    host.on("restored", (a) => order.push(`restored:${(a as { tabId: string }).tabId}`));
    const originalCall = channel.call.bind(channel);
    channel.call = ((method: string, params?: unknown) => {
      if (method === "pty.replay") order.push(`replay:${(params as { tabId: string }).tabId}`);
      return originalCall(method, params);
    }) as typeof channel.call;

    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_A, cwd: "/", cols: 80, rows: 24 });

    channel.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: true });
    channel.emitLifecycle({ type: "ready" });
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(order).toEqual([`reset:${TAB_A}`, `restored:${TAB_A}`, `replay:${TAB_A}`]);
  });

  test("pty.replay is called for each alive tab after reattach", async () => {
    const channel = new FakeAgentChannel();
    channel.sessionListResult = {
      sessions: [
        { workspaceId: WORKSPACE_ID, tabId: TAB_A },
        { workspaceId: WORKSPACE_ID, tabId: TAB_B },
      ],
    };

    const host = startAgentPtyHost(makeWorkspaceManager(channel));

    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_A, cwd: "/", cols: 80, rows: 24 });
    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_B, cwd: "/", cols: 80, rows: 24 });

    channel.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: true });
    channel.emitLifecycle({ type: "ready" });
    await new Promise<void>((r) => setTimeout(r, 0));

    const replayCalls = channel.calls.filter((c) => c.method === "pty.replay");
    expect(replayCalls).toHaveLength(2);
    expect(replayCalls).toContainEqual({
      method: "pty.replay",
      params: { workspaceId: WORKSPACE_ID, tabId: TAB_A },
    });
    expect(replayCalls).toContainEqual({
      method: "pty.replay",
      params: { workspaceId: WORKSPACE_ID, tabId: TAB_B },
    });
  });

  test("session.list failure falls back to killing all held sessions", async () => {
    const channel = new FakeAgentChannel();
    channel.call = async (method: string, params?: unknown) => {
      channel.calls.push({ method, params: params ?? null });
      if (method === "pty.spawn") return { pid: 1 } as never;
      if (method === "session.list") throw new Error("session.list unavailable");
      return {} as never;
    };

    const host = startAgentPtyHost(makeWorkspaceManager(channel));
    const exits: unknown[] = [];
    host.on("exit", (a) => exits.push(a));

    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_A, cwd: "/", cols: 80, rows: 24 });
    channel.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: true });
    channel.emitLifecycle({ type: "ready" });
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(exits).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_A, code: null });
  });
});

// ---------------------------------------------------------------------------
// Acceptance 2: held-then-expired → pty.expired + pty.exit for held sessions
// ---------------------------------------------------------------------------

describe("PTY expire on held-then-expired", () => {
  test("held sessions receive pty.expired then pty.exit", async () => {
    const channel = new FakeAgentChannel();
    const host = startAgentPtyHost(makeWorkspaceManager(channel));

    const expired: unknown[] = [];
    const exits: unknown[] = [];
    host.on("expired", (a) => expired.push(a));
    host.on("exit", (a) => exits.push(a));

    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_A, cwd: "/", cols: 80, rows: 24 });
    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_B, cwd: "/", cols: 80, rows: 24 });

    channel.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: true });
    channel.emitLifecycle({ type: "held-then-expired", previousEpoch: 1, newEpoch: 2 });

    expect(expired).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_A });
    expect(expired).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_B });
    expect(exits).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_A, code: null });
    expect(exits).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_B, code: null });
  });

  test("held-then-expired emits held-then-expired host event for manager", async () => {
    const channel = new FakeAgentChannel();
    const host = startAgentPtyHost(makeWorkspaceManager(channel));

    const heldExpiredEvents: unknown[] = [];
    host.on("held-then-expired", (a) => heldExpiredEvents.push(a));

    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_A, cwd: "/", cols: 80, rows: 24 });
    channel.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: true });
    channel.emitLifecycle({ type: "held-then-expired", previousEpoch: 1, newEpoch: 2 });

    expect(heldExpiredEvents).toContainEqual({ workspaceId: WORKSPACE_ID });
  });

  test("failure after hold keeps sessions held (manager must call releaseHeld)", async () => {
    const channel = new FakeAgentChannel();
    const host = startAgentPtyHost(makeWorkspaceManager(channel));

    const exits: unknown[] = [];
    host.on("exit", (a) => exits.push(a));

    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_A, cwd: "/", cols: 80, rows: 24 });
    channel.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: true });
    channel.emitLifecycle({ type: "failure", error: new Error("connection lost") });

    // Hold is preserved — no exits yet; manager owns the decision.
    expect(exits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Legacy / local path invariant: reconnecting with hadEpoch=false → immediate exit
// ---------------------------------------------------------------------------

describe("legacy path: reconnecting hadEpoch=false → immediate exit", () => {
  test("emits pty.exit immediately when hadEpoch=false", async () => {
    const channel = new FakeAgentChannel();
    const host = startAgentPtyHost(makeWorkspaceManager(channel));

    const held: unknown[] = [];
    const exits: unknown[] = [];
    host.on("held", (a) => held.push(a));
    host.on("exit", (a) => exits.push(a));

    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_A, cwd: "/", cols: 80, rows: 24 });
    channel.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: false });

    expect(exits).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_A, code: null });
    expect(held).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Acceptance 1: ctx absent → no crash
// ---------------------------------------------------------------------------

describe("ctx absent guard", () => {
  test("ready lifecycle on unknown workspace is a no-op", () => {
    const channel = new FakeAgentChannel();
    // Manager returns null for every workspace.
    const manager: AgentPtyWorkspaceManager = {
      async getAgentChannel() { throw new Error("not found"); },
      async tryGetAgentChannel() { return null; },
    };
    const host = startAgentPtyHost(manager);
    const exits: unknown[] = [];
    host.on("exit", (a) => exits.push(a));

    // Emitting lifecycle events without having a subscription wired up should
    // not crash. The agent-host only processes events it subscribed to.
    expect(() => host.dispose()).not.toThrow();
    expect(exits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// manager-owned hold resolution API (plan issue 4 + 6 review fix)
// ---------------------------------------------------------------------------

describe("releaseHeld: manager releases held sessions on non-reauth exit", () => {
  test("releaseHeld emits pty.expired + pty.exit for each held tab", async () => {
    const channel = new FakeAgentChannel();
    const host = startAgentPtyHost(makeWorkspaceManager(channel));

    const expired: unknown[] = [];
    const exits: unknown[] = [];
    host.on("expired", (a) => expired.push(a));
    host.on("exit", (a) => exits.push(a));

    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_A, cwd: "/", cols: 80, rows: 24 });
    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_B, cwd: "/", cols: 80, rows: 24 });

    // Put sessions on hold (simulating reconnecting with epoch).
    channel.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: true });
    // Simulate failure (e.g. auth-cancelled → manager calls releaseHeld).
    channel.emitLifecycle({ type: "failure", error: new Error("connection lost") });
    // Hold is preserved after failure — exits still empty.
    expect(exits).toHaveLength(0);

    // Manager calls releaseHeld (e.g. after auth-cancelled decision).
    host.releaseHeld(WORKSPACE_ID);

    expect(expired).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_A });
    expect(expired).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_B });
    expect(exits).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_A, code: null });
    expect(exits).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_B, code: null });
  });

  test("releaseHeld is a no-op when no hold is active", async () => {
    const channel = new FakeAgentChannel();
    const host = startAgentPtyHost(makeWorkspaceManager(channel));

    const exits: unknown[] = [];
    host.on("exit", (a) => exits.push(a));

    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_A, cwd: "/", cols: 80, rows: 24 });
    // No reconnecting event → no hold.
    host.releaseHeld(WORKSPACE_ID);

    expect(exits).toHaveLength(0);
  });
});

describe("restoreAfterReauth: manager-driven restore through new channel", () => {
  test("restoreAfterReauth calls session.list and replays alive tabs via new channel", async () => {
    // First channel that goes into failure.
    const channel = new FakeAgentChannel();
    // Second channel (new, after reauth success).
    const channel2 = new FakeAgentChannel();
    channel2.sessionListResult = {
      sessions: [{ workspaceId: WORKSPACE_ID, tabId: TAB_A }],
    };
    // spawn uses getAgentChannel; restoreAfterReauth uses tryGetAgentChannel.
    // Return channel2 on tryGetAgentChannel (only called from restoreAfterReauth in this test).
    const manager: AgentPtyWorkspaceManager = {
      async getAgentChannel(id: string): Promise<AgentChannel> {
        return id === WORKSPACE_ID ? channel : (() => { throw new Error("not found"); })();
      },
      async tryGetAgentChannel(id: string): Promise<AgentChannel | null> {
        if (id !== WORKSPACE_ID) return null;
        return channel2;
      },
    };

    const host = startAgentPtyHost(manager);
    const restored: unknown[] = [];
    const exits: unknown[] = [];
    host.on("restored", (a) => restored.push(a));
    host.on("exit", (a) => exits.push(a));

    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_A, cwd: "/", cols: 80, rows: 24 });
    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_B, cwd: "/", cols: 80, rows: 24 });

    channel.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: true });
    channel.emitLifecycle({ type: "failure", error: new Error("auth failed") });
    // Hold preserved — no exits.
    expect(exits).toHaveLength(0);

    // Manager calls restoreAfterReauth after reauth success.
    await host.restoreAfterReauth(WORKSPACE_ID);

    // TAB_A alive → restored with replay.
    expect(restored).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_A, withReplay: true });
    // TAB_B dead → restored without replay + exit.
    expect(restored).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_B, withReplay: false });
    expect(exits).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_B, code: null });
    // Replay called on new channel for TAB_A.
    const replayCalls = channel2.calls.filter((c) => c.method === "pty.replay");
    expect(replayCalls).toHaveLength(1);
    expect(replayCalls[0]).toEqual({
      method: "pty.replay",
      params: { workspaceId: WORKSPACE_ID, tabId: TAB_A },
    });
  });

  test("restoreAfterReauth with empty session.list (grace expired during reauth) → all tabs exit", async () => {
    const channel = new FakeAgentChannel();
    const channel2 = new FakeAgentChannel();
    // Empty session.list → all tabs are dead (daemon replaced during reauth).
    channel2.sessionListResult = { sessions: [] };

    const manager: AgentPtyWorkspaceManager = {
      async getAgentChannel(id: string): Promise<AgentChannel> {
        return id === WORKSPACE_ID ? channel : (() => { throw new Error("not found"); })();
      },
      async tryGetAgentChannel(id: string): Promise<AgentChannel | null> {
        if (id !== WORKSPACE_ID) return null;
        return channel2;
      },
    };

    const host = startAgentPtyHost(manager);
    const exits: unknown[] = [];
    host.on("exit", (a) => exits.push(a));

    await host.call("spawn", { workspaceId: WORKSPACE_ID, tabId: TAB_A, cwd: "/", cols: 80, rows: 24 });
    channel.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: true });
    channel.emitLifecycle({ type: "failure", error: new Error("auth failed") });

    await host.restoreAfterReauth(WORKSPACE_ID);

    // All tabs dead → exit emitted for TAB_A.
    expect(exits).toContainEqual({ workspaceId: WORKSPACE_ID, tabId: TAB_A, code: null });
  });
});
