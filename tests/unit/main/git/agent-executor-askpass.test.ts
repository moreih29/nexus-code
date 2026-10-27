/**
 * Credential prompts of prompting agent requests (push, pull, remote tag and
 * branch operations, interactive run): each request listens for its own
 * prompts by run id, an abort cancels its git, and a prompt it leaves open is
 * withdrawn from the renderer.
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentGitExecutor } from "../../../../src/main/features/git/bridge/agent-executor";
import { GitHelpersIpcManager } from "../../../../src/main/features/git/domain/helpers/ipc";

type AgentEventCallback = (payload: unknown) => void;

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeFixture() {
  const listeners = new Map<string, Set<AgentEventCallback>>();
  const calls: Array<{ method: string; params: Record<string, unknown>; options?: unknown }> = [];
  let settlePush: { resolve: (value: unknown) => void; reject: (error: Error) => void } | null =
    null;
  const callAgentMethod = mock(async (method: string, params?: unknown, options?: unknown) => {
    calls.push({ method, params: (params ?? {}) as Record<string, unknown>, options });
    if (method === "git.push") {
      return await new Promise<unknown>((resolve, reject) => {
        settlePush = { resolve, reject };
      });
    }
    // The agent kills the cancelled git; the push request then fails.
    if (method === "git.cancel") settlePush?.reject(new Error("context canceled"));
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

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-askpass-exec-"));
  tmpRoots.push(userDataDir);
  const broadcasts: Array<{ key: string; args: unknown }> = [];
  const manager = new GitHelpersIpcManager({
    userDataDir,
    broadcast: (channel, event, args) => {
      broadcasts.push({ key: `${channel}.${event}`, args });
    },
    token: "token",
  });
  const executor = new AgentGitExecutor(provider, {
    askpassManager: manager,
    workspaceId: "123e4567-e89b-12d3-a456-426614174001",
  });

  const pushRunId = (): string => {
    const call = calls.find((entry) => entry.method === "git.push");
    if (!call) throw new Error("git.push not called yet");
    return call.params.runId as string;
  };
  const emitPrompt = (requestId: string, runId: string): void => {
    for (const cb of listeners.get("git.askpass.request") ?? []) {
      cb({ requestId, prompt: "Password for 'https://example.test':", runId });
    }
  };
  return {
    executor,
    manager,
    calls,
    broadcasts,
    pushRunId,
    emitPrompt,
    resolvePush: (value: unknown) => settlePush?.resolve(value),
    rejectPush: (error: Error) => settlePush?.reject(error),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AgentGitExecutor credential prompts", () => {
  it("shows a push's prompt and sends the answer back to the agent", async () => {
    const f = makeFixture();
    const push = f.executor.push({ cwd: "/repo" });
    await flush();

    f.emitPrompt("req-1", f.pushRunId());
    expect(f.broadcasts.map((b) => b.key)).toEqual(["askpass.prompt"]);
    f.manager.respondAskpass({ promptId: "req-1", value: "hunter2" });
    await flush();
    expect(f.calls.at(-1)).toMatchObject({
      method: "git.askpass.respond",
      params: { requestId: "req-1", secret: "hunter2" },
    });

    f.resolvePush({ pushed: true });
    expect(await push).toMatchObject({ pushed: true });
    // Answered prompts are not withdrawn.
    expect(f.broadcasts.map((b) => b.key)).toEqual(["askpass.prompt"]);
  });

  it("leaves another request's prompt to that request", async () => {
    const f = makeFixture();
    const push = f.executor.push({ cwd: "/repo" });
    await flush();

    f.emitPrompt("req-other", "some-other-run");
    expect(f.broadcasts).toEqual([]);

    f.resolvePush({ pushed: true });
    await push;
  });

  it("cancels the agent's git on abort and withdraws the open prompt", async () => {
    const f = makeFixture();
    const controller = new AbortController();
    const push = f.executor.push({ cwd: "/repo", signal: controller.signal });
    await flush();
    const runId = f.pushRunId();
    f.emitPrompt("req-1", runId);

    controller.abort();
    await expect(push).rejects.toMatchObject({ name: "AbortError" });
    expect(f.calls.find((c) => c.method === "git.cancel")?.params).toEqual({ streamId: runId });
    expect(f.broadcasts.map((b) => b.key)).toEqual(["askpass.prompt", "askpass.closed"]);
    expect(f.broadcasts[1]?.args).toEqual({ promptId: "req-1" });
  });

  it("gives a push longer than the default request timeout", async () => {
    const f = makeFixture();
    const push = f.executor.push({ cwd: "/repo" });
    await flush();
    expect(f.calls.find((c) => c.method === "git.push")?.options).toEqual({ timeoutMs: 600_000 });
    f.resolvePush({ pushed: true });
    await push;
  });

  it("cancels the agent's git when the push request itself fails", async () => {
    const f = makeFixture();
    const push = f.executor.push({ cwd: "/repo" });
    await flush();
    const runId = f.pushRunId();

    f.rejectPush(new Error("git.push timed out after 600000ms"));
    await expect(push).rejects.toThrow("timed out");
    expect(f.calls.find((c) => c.method === "git.cancel")?.params).toEqual({ streamId: runId });
  });
});
