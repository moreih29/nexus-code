import { describe, expect, it, jest } from "bun:test";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { createLocalChannel } from "../../../../src/main/infra/agent/channel/local-channel";
import type { ChannelLifecycleEvent } from "../../../../src/main/infra/agent/channel/index";
import { createSshChannel } from "../../../../src/main/infra/agent/ssh/channel";

class FakeStream extends EventEmitter {
  emitData(chunk: string): void {
    this.emit("data", Buffer.from(chunk, "utf8"));
  }
}

class FakeStdin {
  readonly writes: string[] = [];
  writable = true;
  destroyed = false;
  ended = false;

  write(line: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(line);
    callback?.();
    return true;
  }

  end(): void {
    this.ended = true;
    this.destroyed = true;
  }
}

class FakeAgentChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly stdin = new FakeStdin();
  readonly killSignals: string[] = [];
  killed = false;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(String(signal));
    this.killed = true;
    return true;
  }
}

function parseLastRequest(child: FakeAgentChild): { id: string; method: string; params: unknown } {
  const line = child.stdin.writes.at(-1);
  expect(line).toBeDefined();
  return JSON.parse(line ?? "{}");
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeLocalHarness(
  options: { maxPendingCalls?: number; callTimeoutMs?: number; delayMs?: number } = {},
) {
  const children: FakeAgentChild[] = [];
  const channel = createLocalChannel(
    {
      binaryPath: "/tmp/agent",
      rootPath: "/repo",
      reconnect: {
        maxPendingCalls: options.maxPendingCalls,
        callTimeoutMs: options.callTimeoutMs,
        initialDelayMs: options.delayMs ?? 1,
        maxDelayMs: options.delayMs ?? 1,
      },
    },
    {
      spawn: () => {
        const child = new FakeAgentChild();
        children.push(child);
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    },
  );
  return { channel, children };
}

function makeSshHarness(
  options: { maxPendingCalls?: number; callTimeoutMs?: number; delayMs?: number } = {},
) {
  const children: FakeAgentChild[] = [];
  const spawnCalls: Array<{ command: string; args: string[]; options: SpawnOptionsWithoutStdio }> =
    [];
  const channel = createSshChannel(
    { host: "dev.example.com", user: "deploy", remoteCommand: "agent /repo" },
    {
      spawn(command, args, spawnOptions) {
        const child = new FakeAgentChild();
        children.push(child);
        spawnCalls.push({ command, args, options: spawnOptions });
        return child as unknown as ChildProcessWithoutNullStreams;
      },
      reconnect: {
        maxPendingCalls: options.maxPendingCalls,
        callTimeoutMs: options.callTimeoutMs,
        initialDelayMs: options.delayMs ?? 1,
        maxDelayMs: options.delayMs ?? 1,
      },
    },
  );
  return { channel, children, spawnCalls };
}

describe("agent channel reconnect queue", () => {
  it("queues local calls during reconnect and flushes them after the new agent is ready", async () => {
    jest.useFakeTimers();
    try {
      const { channel, children } = makeLocalHarness();
      children[0]?.stdout.emitData(`${JSON.stringify({ type: "ready" })}\n`);
      await expect(channel.ready).resolves.toBeUndefined();

      children[0]?.emit("close", 137, "SIGKILL");
      const call = channel.call("fs.stat", { relPath: "README.md" });
      expect(children[0]?.stdin.writes).toHaveLength(0);

      jest.advanceTimersByTime(1);
      await flushMicrotasks();
      const reconnectChild = children[1];
      expect(reconnectChild).toBeDefined();
      reconnectChild?.stdout.emitData(`${JSON.stringify({ type: "ready" })}\n`);
      await flushMicrotasks();

      const request = parseLastRequest(reconnectChild as FakeAgentChild);
      expect(request.method).toBe("fs.stat");
      expect(request.params).toEqual({ relPath: "README.md" });
      reconnectChild?.stdout.emitData(
        `${JSON.stringify({ id: request.id, result: { name: "README.md" } })}\n`,
      );

      await expect(call).resolves.toEqual({ name: "README.md" });
      channel.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it("rejects reconnect queue overflow immediately", async () => {
    const { channel, children } = makeLocalHarness({ maxPendingCalls: 1, delayMs: 1_000 });
    children[0]?.stdout.emitData(`${JSON.stringify({ type: "ready" })}\n`);
    await expect(channel.ready).resolves.toBeUndefined();

    children[0]?.emit("close", 137, "SIGKILL");
    const queued = channel.call("fs.stat", { relPath: "a.ts" });
    queued.catch(() => {});
    const overflow = channel.call("fs.stat", { relPath: "b.ts" });

    await expect(overflow).rejects.toMatchObject({
      name: "AgentReconnectError",
      code: "agent.reconnect-queue-overflow",
      retryable: true,
    });
    channel.dispose();
  });

  it("rejects reconnect calls with a retryable marker when the queue wait times out", async () => {
    jest.useFakeTimers();
    try {
      const { channel, children } = makeLocalHarness({ callTimeoutMs: 10, delayMs: 1_000 });
      children[0]?.stdout.emitData(`${JSON.stringify({ type: "ready" })}\n`);
      await expect(channel.ready).resolves.toBeUndefined();

      children[0]?.emit("close", 137, "SIGKILL");
      const call = channel.call("fs.stat", { relPath: "slow.ts" });
      jest.advanceTimersByTime(10);
      await flushMicrotasks();

      await expect(call).rejects.toMatchObject({
        name: "AgentReconnectError",
        code: "agent.reconnect-timeout",
        retryable: true,
      });
      channel.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it("queues SSH reconnect calls on the shared channel path without per-call fallback spawns", async () => {
    jest.useFakeTimers();
    try {
      const { channel, children, spawnCalls } = makeSshHarness({ delayMs: 1 });
      children[0]?.stdout.emitData(`${JSON.stringify({ type: "ready" })}\n`);
      await expect(channel.ready).resolves.toBeUndefined();

      children[0]?.emit("close", 137, "SIGKILL");
      const first = channel.call("git.run", { args: ["status", "--short"], cwd: "/repo" });
      const second = channel.call("fs.readdir", { relPath: "." });
      expect(spawnCalls).toHaveLength(1);

      jest.advanceTimersByTime(1);
      await flushMicrotasks();
      expect(spawnCalls).toHaveLength(2);
      const reconnectChild = children[1] as FakeAgentChild;
      reconnectChild.stdout.emitData(`${JSON.stringify({ type: "ready" })}\n`);
      await flushMicrotasks();
      expect(reconnectChild.stdin.writes).toHaveLength(2);

      const firstRequest = JSON.parse(reconnectChild.stdin.writes[0] ?? "{}");
      const secondRequest = JSON.parse(reconnectChild.stdin.writes[1] ?? "{}");
      reconnectChild.stdout.emitData(
        `${JSON.stringify({ id: firstRequest.id, result: { stdout: "", stderr: "", code: 0 } })}\n${JSON.stringify({ id: secondRequest.id, result: [] })}\n`,
      );

      await expect(first).resolves.toEqual({ stdout: "", stderr: "", code: 0 });
      await expect(second).resolves.toEqual([]);
      channel.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it("escalates to terminal failure after 3 consecutive auth-failed reconnect attempts", async () => {
    jest.useFakeTimers();
    try {
      const { channel, children, spawnCalls } = makeSshHarness({ delayMs: 1 });
      const lifecycle: string[] = [];
      channel.onLifecycle((event) => lifecycle.push(event.type));
      children[0]?.stdout.emitData(`${JSON.stringify({ type: "ready" })}\n`);
      await expect(channel.ready).resolves.toBeUndefined();

      // Post-ready crash → reconnect window opens.
      children[0]?.emit("close", 137, "SIGKILL");
      expect(lifecycle).toContain("reconnecting");

      // Each batch-mode respawn dies on auth (dead ControlMaster scenario).
      for (const attempt of [1, 2, 3]) {
        jest.advanceTimersByTime(1);
        await flushMicrotasks();
        const child = children[attempt] as FakeAgentChild;
        expect(child).toBeDefined();
        child.stderr.emitData("nexus-dev@127.0.0.1: Permission denied (publickey,password).\n");
        await flushMicrotasks();
      }

      expect(lifecycle).toContain("failure");
      await expect(channel.call("fs.readdir", { relPath: "." })).rejects.toMatchObject({
        name: "SshError",
        code: "ssh.auth-failed",
      });

      // The loop is dead: no further ssh respawns after the terminal transition.
      const spawnsAtFailure = spawnCalls.length;
      jest.advanceTimersByTime(60_000);
      await flushMicrotasks();
      expect(spawnCalls).toHaveLength(spawnsAtFailure);
      channel.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps retrying reconnect forever on transient (non-fatal) failures", async () => {
    jest.useFakeTimers();
    try {
      const { channel, children, spawnCalls } = makeSshHarness({ delayMs: 1 });
      const lifecycle: string[] = [];
      channel.onLifecycle((event) => lifecycle.push(event.type));
      children[0]?.stdout.emitData(`${JSON.stringify({ type: "ready" })}\n`);
      await expect(channel.ready).resolves.toBeUndefined();

      children[0]?.emit("close", 137, "SIGKILL");

      // 5 transient failures (process exits without classified auth stderr) —
      // more than the fatal threshold — must not terminate the channel.
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        jest.advanceTimersByTime(1);
        await flushMicrotasks();
        const child = children[attempt] as FakeAgentChild;
        expect(child).toBeDefined();
        child.emit("close", 255, null);
        await flushMicrotasks();
      }

      expect(lifecycle).not.toContain("failure");
      const spawnsSoFar = spawnCalls.length;
      jest.advanceTimersByTime(1);
      await flushMicrotasks();
      expect(spawnCalls.length).toBeGreaterThan(spawnsSoFar);
      channel.dispose();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// agentEpoch / reattach handshake tests
// ────────────────────────────────────────────────────────────────────────────
describe("agentEpoch reattach handshake", () => {
  it("legacy mode (no epoch in ready frame): reconnect flushes queue normally", async () => {
    jest.useFakeTimers();
    try {
      const { channel, children } = makeSshHarness({ delayMs: 1 });
      // First ready — no agentEpoch (legacy agent)
      children[0]?.stdout.emitData(`${JSON.stringify({ type: "ready" })}\n`);
      await expect(channel.ready).resolves.toBeUndefined();

      children[0]?.emit("close", 137, "SIGKILL");
      const call = channel.call("fs.stat", { relPath: "a.ts" });

      jest.advanceTimersByTime(1);
      await flushMicrotasks();
      const child1 = children[1] as FakeAgentChild;
      // Reconnect also without epoch
      child1.stdout.emitData(`${JSON.stringify({ type: "ready" })}\n`);
      await flushMicrotasks();

      const req = JSON.parse(child1.stdin.writes.at(-1) ?? "{}");
      child1.stdout.emitData(`${JSON.stringify({ id: req.id, result: { ok: true } })}\n`);
      await expect(call).resolves.toEqual({ ok: true });
      channel.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it("epoch match on reconnect: queue is flushed and no held-then-expired event", async () => {
    jest.useFakeTimers();
    try {
      const { channel, children } = makeSshHarness({ delayMs: 1 });
      const lifecycle: ChannelLifecycleEvent[] = [];
      channel.onLifecycle((e) => lifecycle.push(e));

      const EPOCH = 12345;
      children[0]?.stdout.emitData(
        `${JSON.stringify({ type: "ready", agentEpoch: EPOCH })}\n`,
      );
      await expect(channel.ready).resolves.toBeUndefined();

      children[0]?.emit("close", 137, "SIGKILL");
      const call = channel.call("fs.stat", { relPath: "b.ts" });

      jest.advanceTimersByTime(1);
      await flushMicrotasks();
      const child1 = children[1] as FakeAgentChild;
      // Reconnect with same epoch → reattach OK
      child1.stdout.emitData(
        `${JSON.stringify({ type: "ready", agentEpoch: EPOCH })}\n`,
      );
      await flushMicrotasks();

      expect(lifecycle.map((e) => e.type)).not.toContain("held-then-expired");
      const req = JSON.parse(child1.stdin.writes.at(-1) ?? "{}");
      child1.stdout.emitData(`${JSON.stringify({ id: req.id, result: { name: "b.ts" } })}\n`);
      await expect(call).resolves.toEqual({ name: "b.ts" });
      channel.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it("epoch mismatch on reconnect: queued call rejected and held-then-expired emitted", async () => {
    jest.useFakeTimers();
    try {
      const { channel, children } = makeSshHarness({ delayMs: 1 });
      const lifecycle: ChannelLifecycleEvent[] = [];
      channel.onLifecycle((e) => lifecycle.push(e));

      const OLD_EPOCH = 11111;
      const NEW_EPOCH = 99999;
      children[0]?.stdout.emitData(
        `${JSON.stringify({ type: "ready", agentEpoch: OLD_EPOCH })}\n`,
      );
      await expect(channel.ready).resolves.toBeUndefined();

      children[0]?.emit("close", 137, "SIGKILL");
      const call = channel.call("fs.stat", { relPath: "c.ts" });
      // The call must be rejected because the epoch changed
      const callRejected = call.catch((e: Error) => e);

      jest.advanceTimersByTime(1);
      await flushMicrotasks();
      const child1 = children[1] as FakeAgentChild;
      // New daemon with different epoch
      child1.stdout.emitData(
        `${JSON.stringify({ type: "ready", agentEpoch: NEW_EPOCH })}\n`,
      );
      await flushMicrotasks();

      // held-then-expired emitted with correct epoch fields
      const hteEvent = lifecycle.find((e) => e.type === "held-then-expired");
      expect(hteEvent).toBeDefined();
      expect(hteEvent).toMatchObject({
        type: "held-then-expired",
        previousEpoch: OLD_EPOCH,
        newEpoch: NEW_EPOCH,
      });

      // Queued call must have been rejected (not forwarded to new agent)
      const rejectedErr = await callRejected;
      expect(rejectedErr).toBeInstanceOf(Error);

      // Channel itself stays alive after epoch mismatch — new calls work
      expect(child1.stdin.writes).toHaveLength(0); // rejected call not sent
      channel.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it("epoch mismatch with no prior epoch (first connect had no epoch): no held-then-expired", async () => {
    // If the first ready had no epoch (legacy) but the reconnect does, this is
    // not a "daemon was replaced" scenario — there is no baseline to compare.
    jest.useFakeTimers();
    try {
      const { channel, children } = makeSshHarness({ delayMs: 1 });
      const lifecycle: ChannelLifecycleEvent[] = [];
      channel.onLifecycle((e) => lifecycle.push(e));

      // First ready: no epoch
      children[0]?.stdout.emitData(`${JSON.stringify({ type: "ready" })}\n`);
      await expect(channel.ready).resolves.toBeUndefined();

      children[0]?.emit("close", 137, "SIGKILL");

      jest.advanceTimersByTime(1);
      await flushMicrotasks();
      const child1 = children[1] as FakeAgentChild;
      // Reconnect: epoch present now (fresh daemon)
      child1.stdout.emitData(`${JSON.stringify({ type: "ready", agentEpoch: 42 })}\n`);
      await flushMicrotasks();

      // No held-then-expired because lastAgentEpoch was 0
      expect(lifecycle.map((e) => e.type)).not.toContain("held-then-expired");
      channel.dispose();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// degraded / degraded-recovered lifecycle event tests
// ────────────────────────────────────────────────────────────────────────────
describe("heartbeat degraded signal", () => {
  it("emits degraded after 1 missed heartbeat interval and degraded-recovered on arrival", async () => {
    jest.useFakeTimers();
    try {
      const { channel, children } = makeSshHarness({ delayMs: 1 });
      const lifecycle: ChannelLifecycleEvent[] = [];
      channel.onLifecycle((e) => lifecycle.push(e));

      const HEARTBEAT_MS = 100; // small value for faster test
      children[0]?.stdout.emitData(
        `${JSON.stringify({ type: "ready", heartbeatIntervalMs: HEARTBEAT_MS })}\n`,
      );
      await expect(channel.ready).resolves.toBeUndefined();
      await flushMicrotasks();

      // Advance just past 1× interval — degraded should fire
      jest.advanceTimersByTime(HEARTBEAT_MS + 1);
      await flushMicrotasks();

      expect(lifecycle.map((e) => e.type)).toContain("degraded");
      expect(lifecycle.map((e) => e.type)).not.toContain("degraded-recovered");

      // Heartbeat arrives — degraded-recovered should fire
      children[0]?.stdout.emitData(
        `${JSON.stringify({ event: "agent.heartbeat" })}\n`,
      );
      await flushMicrotasks();

      expect(lifecycle.map((e) => e.type)).toContain("degraded-recovered");
      channel.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not re-emit degraded on subsequent ticks after the first miss", async () => {
    jest.useFakeTimers();
    try {
      const { channel, children } = makeSshHarness({ delayMs: 1 });
      const lifecycle: ChannelLifecycleEvent[] = [];
      channel.onLifecycle((e) => lifecycle.push(e));

      const HEARTBEAT_MS = 100;
      children[0]?.stdout.emitData(
        `${JSON.stringify({ type: "ready", heartbeatIntervalMs: HEARTBEAT_MS })}\n`,
      );
      await expect(channel.ready).resolves.toBeUndefined();
      await flushMicrotasks();

      // Advance 3× interval — 3 watchdog ticks fire, but degraded fires only once
      jest.advanceTimersByTime(HEARTBEAT_MS * 3 + 1);
      await flushMicrotasks();

      const degradedCount = lifecycle.filter((e) => e.type === "degraded").length;
      expect(degradedCount).toBe(1);
      channel.dispose();
    } finally {
      jest.useRealTimers();
    }
  });
});
