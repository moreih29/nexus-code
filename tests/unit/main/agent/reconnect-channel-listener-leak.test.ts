/**
 * Regression coverage for the channel→pipe listener-leak fix.
 *
 * Before the fix, `createReconnectingProcessChannel.on(event, cb)` stored the
 * callback in a channel-level Set and — on the first registration for that
 * event — installed exactly one fan-out wrapper on the underlying pipe via
 * `pipe.on()`. The fan-out wrapper's unsubscribe handle was discarded. When
 * the last callback was removed, the channel cleared its own Set and deleted
 * the entry, but the pipe-side wrapper stayed attached to the pipe's listener
 * Set forever. Each subsequent subscribe→unsubscribe cycle therefore left one
 * orphan wrapper on the pipe; an event emitted afterward fanned out across
 * every orphan wrapper, multiplying delivery to the live callback set.
 *
 * The fix stores the pipe-side unsubscribe in a per-event bucket and invokes
 * it when the bucket's callback Set drops to zero. This test pins the
 * behavior via the channel's observable side effect: after N sub/unsub
 * cycles and one fresh subscription, a single emitted event must invoke the
 * callback exactly once (not N+1 times).
 */
import { describe, expect, it } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createLocalChannel } from "../../../../src/main/infra/agent/channel/local-channel";

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

async function readyHandshake(child: FakeAgentChild): Promise<void> {
  child.stdout.emitData(`${JSON.stringify({ type: "ready", protocolVersion: "1.0" })}\n`);
  await flushMicrotasks();
}

function emitEvent(child: FakeAgentChild, event: string, payload: unknown): void {
  child.stdout.emitData(`${JSON.stringify({ event, payload })}\n`);
}

describe("reconnecting-process-channel listener lifecycle", () => {
  it("delivers exactly once after one subscribe-unsubscribe cycle", async () => {
    const { channel, children } = makeHarness();
    await readyHandshake(children[0]!);

    // Initial subscribe-then-unsubscribe should fully release the pipe-side
    // wrapper. The next subscriber must receive each emit exactly once — a
    // duplicate wrapper still attached to the pipe would deliver twice.
    const firstUnsub = channel.on("git.log.batch", () => {});
    firstUnsub();

    let calls = 0;
    channel.on("git.log.batch", () => {
      calls++;
    });
    emitEvent(children[0]!, "git.log.batch", { streamId: "x", entries: [] });
    await flushMicrotasks();

    expect(calls).toBe(1);
    channel.dispose();
  });

  it("does not accumulate orphan wrappers across repeated subscribe-unsubscribe cycles", async () => {
    const { channel, children } = makeHarness();
    await readyHandshake(children[0]!);

    // Pre-fix: each iteration leaves one orphan wrapper attached to the pipe.
    // After 5 cycles, the pipe holds 5 orphan wrappers (plus the active one
    // from the final subscription), so one emit triggers the live callback
    // 6 times. The fix releases the wrapper on unsubscribe, keeping pipe
    // listeners bounded to the channel's live consumer count.
    for (let i = 0; i < 5; i++) {
      const unsub = channel.on("git.log.batch", () => {});
      unsub();
    }

    let calls = 0;
    channel.on("git.log.batch", () => {
      calls++;
    });

    emitEvent(children[0]!, "git.log.batch", { streamId: "y", entries: [] });
    await flushMicrotasks();

    // Exactly one delivery — any number greater than 1 indicates orphan
    // wrappers are still fanning out alongside the live subscription.
    expect(calls).toBe(1);
    channel.dispose();
  });

  it("fans out to all live callbacks (sanity) while still releasing the pipe wrapper after the last unsubscribe", async () => {
    const { channel, children } = makeHarness();
    await readyHandshake(children[0]!);

    let aCalls = 0;
    let bCalls = 0;
    const unsubA = channel.on("git.log.batch", () => {
      aCalls++;
    });
    const unsubB = channel.on("git.log.batch", () => {
      bCalls++;
    });

    emitEvent(children[0]!, "git.log.batch", { streamId: "1", entries: [] });
    await flushMicrotasks();
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);

    // Removing one callback leaves the other receiving normally — the
    // pipe-side wrapper must remain installed while there is still at least
    // one live consumer.
    unsubA();
    emitEvent(children[0]!, "git.log.batch", { streamId: "2", entries: [] });
    await flushMicrotasks();
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(2);

    // Removing the last callback releases the wrapper. A subsequent emit
    // must not invoke any prior callbacks (none are alive) and a fresh
    // subscription afterward must still receive exactly once.
    unsubB();
    emitEvent(children[0]!, "git.log.batch", { streamId: "3", entries: [] });
    await flushMicrotasks();
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(2);

    let cCalls = 0;
    channel.on("git.log.batch", () => {
      cCalls++;
    });
    emitEvent(children[0]!, "git.log.batch", { streamId: "4", entries: [] });
    await flushMicrotasks();
    expect(cCalls).toBe(1);

    channel.dispose();
  });
});
