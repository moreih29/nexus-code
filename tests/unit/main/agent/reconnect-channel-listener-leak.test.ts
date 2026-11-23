import { describe, expect, it } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createLocalChannel } from "../../../../src/main/infra/agent/channel/local-channel";
import { AGENT_PROTOCOL_VERSION } from "../../../../src/shared/agent/envelope";

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
  child.stdout.emitData(
    `${JSON.stringify({ type: "ready", protocolVersion: `${AGENT_PROTOCOL_VERSION}.0` })}\n`,
  );
  await flushMicrotasks();
}

function emitEvent(child: FakeAgentChild, event: string, payload: unknown): void {
  child.stdout.emitData(`${JSON.stringify({ event, payload })}\n`);
}

describe("reconnecting-process-channel listener lifecycle", () => {
  it("delivers exactly once after one subscribe-unsubscribe cycle", async () => {
    const { channel, children } = makeHarness();
    await readyHandshake(children[0]!);

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

    unsubA();
    emitEvent(children[0]!, "git.log.batch", { streamId: "2", entries: [] });
    await flushMicrotasks();
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(2);

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
