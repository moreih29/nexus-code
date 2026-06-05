import { describe, expect, it, jest } from "bun:test";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { createLocalChannel } from "../../../../src/main/infra/agent/channel/local-channel";
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
