/**
 * A remote terminal the user closed, or was told had ended, must not keep
 * running on the agent's daemon. Its kill can be lost on a link that is
 * failing, it can overtake the tab's spawn, and a daemon the app reattaches to
 * (reconnect, re-authentication, Connect, app restart) still runs every
 * session of the outage. The agent host kills, when it reaches the daemon
 * again, every session no tab wants: closed, ended, or unknown to the app.
 */
import { describe, expect, test } from "bun:test";
import type { AgentPtyWorkspaceManager } from "../../../../src/main/features/pty/agent-host";
import { startAgentPtyHost } from "../../../../src/main/features/pty/agent-host";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
  ChannelLifecycleEvent,
} from "../../../../src/main/infra/agent/channel";
import { createAgentReconnectError } from "../../../../src/main/infra/agent/channel/reconnecting-process-channel";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TAB_A = "11111111-1111-4111-8111-111111111111";
const TAB_B = "22222222-2222-4222-8222-222222222222";
const TAB_X = "33333333-3333-4333-8333-333333333333";

/** A daemon's channel: the sessions it runs, and what it was asked. */
class FakeDaemonChannel implements AgentChannel {
  readonly ready = Promise.resolve();
  readonly calls: Array<{ method: string; tabId?: string }> = [];
  /** Tab ids the daemon runs a session for. */
  readonly sessions = new Set<string>();
  /** When set, pty.kill fails with it, as on a link that went down. */
  killError: Error | null = null;
  /** When set, pty.spawn answers only once it resolves. */
  spawnGate: Promise<void> | null = null;
  readonly order: string[] = [];
  private readonly eventListeners = new Map<string, Set<ChannelEventCallback>>();
  private readonly lifecycleListeners = new Set<ChannelLifecycleCallback>();

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const tabId = (params as { tabId?: string } | undefined)?.tabId;
    this.calls.push({ method, ...(tabId ? { tabId } : {}) });
    switch (method) {
      case "pty.spawn": {
        this.order.push(`spawn sent ${tabId}`);
        if (this.spawnGate) await this.spawnGate;
        const attached = tabId !== undefined && this.sessions.has(tabId);
        if (tabId) this.sessions.add(tabId);
        this.order.push(`spawn answered ${tabId}`);
        return (attached ? { pid: 1, attached: true } : { pid: 1 }) as T;
      }
      case "pty.kill":
        this.order.push(`kill sent ${tabId}`);
        if (this.killError) throw this.killError;
        if (tabId) this.sessions.delete(tabId);
        return {} as T;
      case "session.list":
        return {
          sessions: Array.from(this.sessions, (id) => ({ workspaceId: WS, tabId: id })),
        } as T;
      default:
        return {} as T;
    }
  }

  fire(): void {}

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

  emit(event: string, payload: unknown): void {
    for (const cb of Array.from(this.eventListeners.get(event) ?? [])) cb(payload);
  }

  dispose(): void {}

  kills(tabId: string): number {
    return this.calls.filter((c) => c.method === "pty.kill" && c.tabId === tabId).length;
  }

  replays(tabId: string): number {
    return this.calls.filter((c) => c.method === "pty.replay" && c.tabId === tabId).length;
  }
}

/** A workspace manager whose channel can be replaced, as a new connection does. */
function makeManager(first: FakeDaemonChannel) {
  let channel = first;
  const readyListeners = new Set<(workspaceId: string) => void>();
  const manager: AgentPtyWorkspaceManager = {
    async getAgentChannel() {
      return channel;
    },
    async tryGetAgentChannel(id) {
      return id === WS ? channel : null;
    },
    onProviderReady(listener) {
      readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
  };
  return {
    manager,
    /** A new connection: its provider is ready on `next`. */
    connect(next: FakeDaemonChannel) {
      channel = next;
      for (const listener of readyListeners) listener(WS);
    },
  };
}

function spawnArgs(tabId: string) {
  return { workspaceId: WS, tabId, cwd: "/", cols: 80, rows: 24 };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

describe("a closed tab whose kill was lost", () => {
  test("is killed, not replayed, when the same daemon comes back", async () => {
    const channel = new FakeDaemonChannel();
    const host = startAgentPtyHost(makeManager(channel).manager);
    const restored: Array<{ tabId: string }> = [];
    const held: Array<{ tabId: string }> = [];
    host.on("restored", (a) => restored.push(a as { tabId: string }));
    host.on("held", (a) => held.push(a as { tabId: string }));
    await host.call("spawn", spawnArgs(TAB_A));
    await host.call("spawn", spawnArgs(TAB_B));

    // Unstable link: the kill goes out on an ssh that is already dead, and
    // fails once ServerAlive gives up on it.
    channel.killError = createAgentReconnectError("agent.reconnect-in-progress");
    await host.call("kill", { workspaceId: WS, tabId: TAB_A }).catch(() => {});
    channel.killError = null;

    channel.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: true });
    channel.emitLifecycle({ type: "ready" });
    await settle();

    expect(held.map((h) => h.tabId)).toEqual([TAB_B]);
    expect(channel.replays(TAB_A)).toBe(0);
    expect(restored.map((r) => r.tabId)).toEqual([TAB_B]);
    expect(channel.replays(TAB_B)).toBe(1);
    expect(channel.kills(TAB_A)).toBe(2);
    expect(channel.sessions.has(TAB_A)).toBe(false);
  });

  test("is killed, not replayed, after re-authentication", async () => {
    const first = new FakeDaemonChannel();
    const { manager, connect } = makeManager(first);
    const host = startAgentPtyHost(manager);
    const restored: Array<{ tabId: string }> = [];
    host.on("restored", (a) => restored.push(a as { tabId: string }));
    await host.call("spawn", spawnArgs(TAB_A));

    first.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: true });
    // Closed while reconnecting: the kill waits in the reconnect queue and
    // times out there.
    first.killError = createAgentReconnectError("agent.reconnect-timeout");
    await host.call("kill", { workspaceId: WS, tabId: TAB_A }).catch(() => {});
    first.emitLifecycle({ type: "failure", error: new Error("ssh.auth-failed") });

    // The password is asked again, and the app is back on the same daemon.
    const second = new FakeDaemonChannel();
    second.sessions.add(TAB_A);
    connect(second);
    await host.restoreAfterReauth(WS);
    await settle();

    expect(second.replays(TAB_A)).toBe(0);
    expect(restored).toEqual([]);
    expect(second.kills(TAB_A)).toBeGreaterThanOrEqual(1);
    expect(second.sessions.has(TAB_A)).toBe(false);
  });
});

describe("a tab the app showed as ended", () => {
  test("has its session killed when the workspace connects again", async () => {
    const first = new FakeDaemonChannel();
    const { manager, connect } = makeManager(first);
    const host = startAgentPtyHost(manager);
    const expired: Array<{ tabId: string }> = [];
    host.on("expired", (a) => expired.push(a as { tabId: string }));
    await host.call("spawn", spawnArgs(TAB_A));

    first.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: true });
    first.emitLifecycle({ type: "failure", error: new Error("ssh.auth-failed") });
    // Re-authentication cancelled: the terminal says its session expired.
    host.releaseHeld(WS);
    expect(expired.map((e) => e.tabId)).toEqual([TAB_A]);

    // Connect, within the daemon's grace: the same daemon still runs it.
    const second = new FakeDaemonChannel();
    second.sessions.add(TAB_A);
    connect(second);
    await settle();

    expect(second.kills(TAB_A)).toBe(1);
    expect(second.sessions.has(TAB_A)).toBe(false);
  });

  test("keeps the session of an ended tab reopened before the agent is reached", async () => {
    const first = new FakeDaemonChannel();
    const { manager, connect } = makeManager(first);
    const host = startAgentPtyHost(manager);
    await host.call("spawn", spawnArgs(TAB_A));
    first.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: true });
    first.emitLifecycle({ type: "failure", error: new Error("ssh.auth-failed") });
    host.releaseHeld(WS);

    const second = new FakeDaemonChannel();
    second.sessions.add(TAB_A);
    connect(second);
    // Reopen: the tab wants a session again.
    await host.call("spawn", spawnArgs(TAB_A));
    await settle();

    expect(second.kills(TAB_A)).toBe(0);
  });
});

describe("the sessions of a daemon the app reattaches to", () => {
  test("those of tabs the app no longer has are killed; restored tabs keep theirs", async () => {
    const channel = new FakeDaemonChannel();
    // After an app restart: the daemon runs A, which a saved tab will
    // reattach to, and X, whose tab was closed while its kill could not
    // reach the daemon.
    channel.sessions.add(TAB_A);
    channel.sessions.add(TAB_X);
    const { manager, connect } = makeManager(channel);
    const host = startAgentPtyHost(manager, {
      knownTerminalTabs: () => new Set([TAB_A, TAB_B]),
    });

    connect(channel);
    await settle();

    expect(channel.kills(TAB_X)).toBe(1);
    expect(channel.kills(TAB_A)).toBe(0);
    // The restored tab then attaches to its session.
    const result = await host.call("spawn", spawnArgs(TAB_A));
    expect(result).toEqual({ pid: 1, attached: true });
  });

  test("a tab opened since the tabs were last saved keeps its session", async () => {
    const channel = new FakeDaemonChannel();
    const { manager, connect } = makeManager(channel);
    const host = startAgentPtyHost(manager, { knownTerminalTabs: () => new Set() });
    await host.call("spawn", spawnArgs(TAB_B));

    channel.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: true });
    channel.emitLifecycle({ type: "ready" });
    connect(channel);
    await settle();

    expect(channel.kills(TAB_B)).toBe(0);
  });

  test("without the saved tabs, only sessions known to be unwanted are killed", async () => {
    const channel = new FakeDaemonChannel();
    channel.sessions.add(TAB_X);
    const { manager, connect } = makeManager(channel);
    startAgentPtyHost(manager);

    connect(channel);
    await settle();

    expect(channel.kills(TAB_X)).toBe(0);
  });

  test("a closed tab is killed when the same daemon comes back with no tab held", async () => {
    const channel = new FakeDaemonChannel();
    const host = startAgentPtyHost(makeManager(channel).manager);
    await host.call("spawn", spawnArgs(TAB_A));
    channel.killError = createAgentReconnectError("agent.reconnect-in-progress");
    await host.call("kill", { workspaceId: WS, tabId: TAB_A }).catch(() => {});
    channel.killError = null;

    // No live tab left: nothing is held over the outage.
    channel.emitLifecycle({ type: "reconnecting", cause: null, hadEpoch: true });
    channel.emitLifecycle({ type: "ready" });
    await settle();

    expect(channel.kills(TAB_A)).toBe(2);
    expect(channel.sessions.has(TAB_A)).toBe(false);
  });
});

describe("a tab closed while it starts", () => {
  test("is killed only once its spawn has been answered", async () => {
    const channel = new FakeDaemonChannel();
    let answerSpawn = () => {};
    channel.spawnGate = new Promise<void>((resolve) => {
      answerSpawn = resolve;
    });
    const host = startAgentPtyHost(makeManager(channel).manager);

    const spawning = host.call("spawn", spawnArgs(TAB_A));
    await settle();
    const killing = host.call("kill", { workspaceId: WS, tabId: TAB_A });
    await settle();
    answerSpawn();
    await spawning;
    await killing;
    await settle();

    expect(channel.order).toEqual([
      `spawn sent ${TAB_A}`,
      `spawn answered ${TAB_A}`,
      `kill sent ${TAB_A}`,
    ]);
    expect(channel.sessions.has(TAB_A)).toBe(false);
  });

  test("is not replayed by a spawn that attached after it was closed", async () => {
    const channel = new FakeDaemonChannel();
    channel.sessions.add(TAB_A);
    let answerSpawn = () => {};
    channel.spawnGate = new Promise<void>((resolve) => {
      answerSpawn = resolve;
    });
    const host = startAgentPtyHost(makeManager(channel).manager);

    const spawning = host.call("spawn", spawnArgs(TAB_A));
    await settle();
    const killing = host.call("kill", { workspaceId: WS, tabId: TAB_A });
    answerSpawn();
    await spawning;
    await killing;
    await settle();

    expect(channel.replays(TAB_A)).toBe(0);
    expect(channel.sessions.has(TAB_A)).toBe(false);
  });
});
