import { describe, expect, it, mock } from "bun:test";
import { AgentGitExecutor } from "../../../../../../../src/main/features/git/bridge/agent-executor";

type AgentEventCallback = (payload: unknown) => void;

function makeFixture() {
  const listeners = new Map<string, Set<AgentEventCallback>>();
  const callLog: Array<{ method: string; params: unknown }> = [];
  const callAgentMethod = mock(async (method: string, params?: unknown) => {
    callLog.push({ method, params });
    if (method === "git.log") return await new Promise<unknown>(() => {});
    return undefined;
  });
  const provider = {
    kind: "local" as const,
    callAgentMethod,
    onAgentEvent: (event: string, callback: AgentEventCallback): (() => void) => {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(callback);
      return () => {
        listeners.get(event)?.delete(callback);
      };
    },
    onAgentLifecycle: () => () => {},
    isAgentAvailable: () => true,
  };
  const executor = new AgentGitExecutor(provider);
  const getStreamId = (): string => {
    for (let i = callLog.length - 1; i >= 0; i--) {
      const entry = callLog[i];
      if (entry?.method === "git.log") return (entry.params as { streamId: string }).streamId;
    }
    throw new Error("git.log not invoked yet");
  };
  const emit = (streamId: string): void => {
    const set = listeners.get("git.log.batch");
    if (!set) throw new Error("no listeners on git.log.batch");
    for (const cb of set) cb({ streamId, entries: [] });
  };
  return {
    executor,
    listeners,
    callAgentMethod,
    sizeFor: (event: string): number => listeners.get(event)?.size ?? 0,
    getStreamId,
    emit,
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("AgentGitExecutor.log listener lifecycle", () => {
  it("registers exactly one git.log.batch listener when a stream starts", async () => {
    const { executor, sizeFor } = makeFixture();
    const controller = new AbortController();

    const generator = executor.log({
      bin: "git",
      cwd: "/repo",
      ref: "main",
      scope: "ref",
      signal: controller.signal,
    });
    void generator.next().catch(() => {});
    await flushMicrotasks();

    expect(sizeFor("git.log.batch")).toBe(1);

    controller.abort();
    await flushMicrotasks();
  });

  it("removes the listener immediately when an aborted stream is parked at yield (the real leak vector)", async () => {
    const { executor, sizeFor, getStreamId, emit } = makeFixture();
    const controller = new AbortController();

    const generator = executor.log({
      bin: "git",
      cwd: "/repo",
      ref: "main",
      scope: "ref",
      signal: controller.signal,
    });

    const firstNext = generator.next();
    await flushMicrotasks();
    expect(sizeFor("git.log.batch")).toBe(1);

    emit(getStreamId());
    const first = await firstNext;
    expect(first.done).toBe(false);

    controller.abort();
    await flushMicrotasks();

    expect(sizeFor("git.log.batch")).toBe(0);
  });

  it("does not accumulate listeners across repeated abort/restart cycles", async () => {
    const { executor, sizeFor, getStreamId, emit, listeners } = makeFixture();

    for (let i = 0; i < 5; i++) {
      const controller = new AbortController();
      const generator = executor.log({
        bin: "git",
        cwd: "/repo",
        ref: "main",
        scope: "ref",
        signal: controller.signal,
      });
      const firstNext = generator.next();
      await flushMicrotasks();

      expect(sizeFor("git.log.batch")).toBe(1);

      emit(getStreamId());
      const result = await firstNext;
      expect(result.done).toBe(false);

      controller.abort();
      await flushMicrotasks();

      expect(sizeFor("git.log.batch")).toBe(0);

      expect(listeners.get("git.log.batch")?.size ?? 0).toBeLessThanOrEqual(1);
    }
  });
});
