/**
 * Regression coverage for the streamAgentEvents listener-leak fix.
 *
 * Before the fix, AgentGitExecutor's stream generators registered an
 * onAgentEvent listener and only unsubscribed inside the generator's
 * finally block. The IPC stream router skips closing aborted generators
 * (cleanupStream's `!signal.aborted` guard), so an aborted stream parked
 * at its yield point left the generator alive forever and the listener
 * was never removed from the workspace channel. Workspace switches and
 * the History panel's auto-refresh both feed aborts, accumulating
 * listeners that the agent's next batch event fanned out across.
 *
 * The fix moves the teardown out of `finally`-only into an idempotent
 * `tearDown()` invoked from BOTH the abort handler and the finally.
 *
 * The critical leak vector is: generator yielded once, consumer never
 * resumed, abort fires. With the old code, `queue.fail()` queues a
 * rejection that the suspended generator cannot observe (it is parked
 * at `yield`, not at an `await`), so the finally block never runs and
 * the listener stays attached. These tests reproduce exactly that.
 */
import { describe, expect, it, mock } from "bun:test";
import { AgentGitExecutor } from "../../../../src/main/features/git/bridge/agent-executor";

type AgentEventCallback = (payload: unknown) => void;

function makeFixture() {
  // Per-event callback Set so the test can assert directly on size /
  // membership the same way the real pipe.ts channel does.
  const listeners = new Map<string, Set<AgentEventCallback>>();
  // Capture the params of the first callAgentMethod invocation (the git.log
  // call) so we can read back the generated streamId and push payloads that
  // parseGitLogBatch accepts.
  const callLog: Array<{ method: string; params: unknown }> = [];
  const callAgentMethod = mock(async (method: string, params?: unknown) => {
    callLog.push({ method, params });
    // The git.log RPC stays pending forever — the generator must rely on
    // its own teardown path rather than on the RPC promise settling. The
    // GIT_CANCEL_METHOD invocation issued by tearDown resolves immediately
    // (default mock behavior) and is irrelevant to the listener accounting.
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
    // Walk from the end so repeat iterations get the freshly-issued
    // streamId (each restart issues a new randomUUID).
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
    // Kick the body so the synchronous prelude (including onAgentEvent
    // registration) actually runs. Swallow the rejection that abort will
    // eventually deliver so it is not flagged as an unhandled rejection.
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

    // 1. First .next() runs the body up to the first `await queue.next()`.
    //    The listener is now registered.
    const firstNext = generator.next();
    await flushMicrotasks();
    expect(sizeFor("git.log.batch")).toBe(1);

    // 2. Push one valid event. The queue wakes the await; the generator
    //    advances past the if-done check and yields. After this resolves
    //    the generator is parked at the `yield` line — NOT at an await.
    emit(getStreamId());
    const first = await firstNext;
    expect(first.done).toBe(false);

    // 3. Abort. With the pre-fix code, abort's only action is
    //    queue.fail(), which queues a rejection the suspended generator
    //    cannot observe (it is parked at `yield`, not awaiting the
    //    queue). The router's cleanupStream skips `.return()` on aborted
    //    streams, so the body's finally never runs and the listener
    //    stays attached forever. The fixed code calls tearDown() inside
    //    the abort handler, removing the listener synchronously.
    //
    // No further `generator.next()` calls — that simulates the IPC
    // router's behavior: it acknowledges the abort to the renderer and
    // moves on, leaving the generator parked.
    controller.abort();
    await flushMicrotasks();

    expect(sizeFor("git.log.batch")).toBe(0);
  });

  it("does not accumulate listeners across repeated abort/restart cycles", async () => {
    const { executor, sizeFor, getStreamId, emit, listeners } = makeFixture();

    for (let i = 0; i < 5; i++) {
      // Clear the per-iteration callLog by reading streamId from a fresh
      // generator — the fixture's callLog grows but getStreamId returns
      // the most recent git.log entry only if we always read the latest
      // one. Helper rewrites the lookup each iteration for clarity.
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

      // Each iteration replaces the previous listener — one alive at a
      // time, never growing beyond a single active subscription. (The
      // previous iteration's listener was torn down by abort.)
      expect(sizeFor("git.log.batch")).toBe(1);

      // Drive into the yield state so the abort exercises the real leak
      // vector (parked at yield, not at await).
      emit(getStreamId());
      const result = await firstNext;
      expect(result.done).toBe(false);

      controller.abort();
      await flushMicrotasks();

      expect(sizeFor("git.log.batch")).toBe(0);

      // Sanity: the channel-side Set is the same instance the executor
      // shares with the fixture, so an emit-and-park leak would compound
      // it iteration over iteration. Clamp to a one-at-most invariant.
      expect(listeners.get("git.log.batch")?.size ?? 0).toBeLessThanOrEqual(1);
    }
  });
});
