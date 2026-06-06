/**
 * Regression: the `ready` lifecycle event was only emitted on the epoch-match
 * reattach path, so local agents (epoch 0) reconnected silently — stateful
 * consumers (fs.watch / git.watch replay) had no signal that a replacement
 * agent process was now serving the channel.
 */

import { describe, expect, it, jest } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createLocalChannel } from "../../../../src/main/infra/agent/channel/local-channel";
import type { ChannelLifecycleEvent } from "../../../../src/main/infra/agent/channel/index";

class FakeStream extends EventEmitter {
  emitData(chunk: string): void {
    this.emit("data", Buffer.from(chunk, "utf8"));
  }
}

class FakeStdin {
  readonly writes: string[] = [];
  writable = true;
  destroyed = false;

  write(line: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(line);
    callback?.();
    return true;
  }

  end(): void {
    this.destroyed = true;
  }
}

class FakeAgentChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly stdin = new FakeStdin();
  killed = false;

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    return true;
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeHarness() {
  const children: FakeAgentChild[] = [];
  const channel = createLocalChannel(
    {
      binaryPath: "/tmp/agent",
      rootPath: "/repo",
      reconnect: { initialDelayMs: 1, maxDelayMs: 1 },
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

describe("no-epoch reconnect emits the ready lifecycle event", () => {
  it("emits ready after a successful local (epoch-less) reconnect handshake", async () => {
    jest.useFakeTimers();
    try {
      const { channel, children } = makeHarness();
      const events: ChannelLifecycleEvent[] = [];
      channel.onLifecycle((event) => events.push(event));

      children[0]?.stdout.emitData(`${JSON.stringify({ type: "ready" })}\n`);
      await expect(channel.ready).resolves.toBeUndefined();
      // First connect must NOT emit a lifecycle ready (nothing to replay yet).
      expect(events.filter((e) => e.type === "ready")).toHaveLength(0);

      children[0]?.emit("close", 137, "SIGKILL");
      jest.advanceTimersByTime(1);
      await flushMicrotasks();

      const reconnectChild = children[1];
      expect(reconnectChild).toBeDefined();
      reconnectChild?.stdout.emitData(`${JSON.stringify({ type: "ready" })}\n`);
      await flushMicrotasks();

      expect(events.filter((e) => e.type === "ready")).toHaveLength(1);
      channel.dispose();
    } finally {
      jest.useRealTimers();
    }
  });
});
