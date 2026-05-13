/**
 * Scenario tests for the workspace-agnostic clone backend.
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  GitExecutor,
  GitProcessOptions,
  RunGitOptions,
} from "../../../../src/main/bridge/git/types";
import { cloneStream } from "../../../../src/main/ipc/channels/git/clone-handlers";
import { runClone } from "../../../../src/main/git/git-clone";
import type { GitError } from "../../../../src/main/git/git-error";
import type { GitRegistry } from "../../../../src/main/git/git-registry";
import type { StreamContext } from "../../../../src/main/ipc/router";
import type {
  GitCloneEvent,
  GitCloneStreamProgressEvent,
  GitCloneStreamResultEvent,
} from "../../../../src/shared/types/git";

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174032";
const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

describe("runClone", () => {
  it("rejects a pre-existing destination before invoking git", async () => {
    const parent = await makeTempDir();
    const { executor, calls } = fakeExecutor(async function* () {
      yield* [];
      throw new Error("executor stream should not run for pre-existing destinations");
    });
    await fs.promises.mkdir(path.join(parent, "repo"));

    await expect(
      runClone(
        {
          executor,
          bin: "git",
          url: "https://example.invalid/repo.git",
          destination: parent,
          name: "repo",
        },
        () => {},
      ),
    ).rejects.toMatchObject({ kind: "clone-destination-exists" } satisfies Partial<GitError>);

    expect(calls).toHaveLength(0);
    await expect(fs.promises.stat(path.join(parent, "repo"))).resolves.toBeDefined();
  });

  it("cancels a running clone and removes only the owned destination", async () => {
    const parent = await makeTempDir();
    const { executor } = fakeExecutor(async function* (options) {
      const target = String(options.args.at(-1));
      await fs.promises.writeFile(path.join(target, "partial.txt"), "owned");
      yield Buffer.from("Receiving objects: 60% (6/10)\n");
      await waitForAbort(options.signal);
      throw abortError();
    });
    const events: GitCloneEvent[] = [];
    const controller = new AbortController();

    const clone = runClone(
      {
        executor,
        bin: "git",
        url: "https://example.invalid/repo.git",
        destination: parent,
        name: "repo",
      },
      (event) => events.push(event),
      controller.signal,
    );

    await waitFor(() => events.some((event) => event.kind === "progress" && event.pct >= 60));
    controller.abort();

    await expect(clone).resolves.toEqual({
      kind: "cancelled",
      absPath: path.join(parent, "repo"),
      cleaned: true,
    });
    expect(events.at(-1)).toMatchObject({ kind: "cancelled", cleaned: true });
    await expect(pathExists(path.join(parent, "repo"))).resolves.toBe(false);
  });

  it("executes clone through GitExecutor.stream with interactive stderr progress", async () => {
    const parent = await makeTempDir();
    const { executor, calls } = fakeExecutor(async function* () {
      yield Buffer.from("Updating files: 100% (1/1)\n");
    });
    const events: GitCloneEvent[] = [];

    const result = await runClone(
      {
        executor,
        bin: "git",
        url: "git@github.com:org/repo.git",
        destination: parent,
        name: "repo",
        branch: "main",
        recurseSubmodules: true,
        env: { NEXUS_CLONE_TEST_LOG: "1" },
      },
      (event) => events.push(event),
    );

    expect(result).toEqual({ kind: "complete", absPath: path.join(parent, "repo") });
    expect(events.map((event) => event.kind)).toContain("started");
    expect(events).toContainEqual({ kind: "phase", phase: "checkout" });
    expect(events.at(-1)).toEqual(result);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      bin: "git",
      cwd: parent,
      args: [
        "clone",
        "--progress",
        "--branch",
        "main",
        "--recurse-submodules",
        "git@github.com:org/repo.git",
        path.join(parent, "repo"),
      ],
      env: { NEXUS_CLONE_TEST_LOG: "1" },
      interactive: true,
      streamStderr: true,
    });
  });

  it("does not reintroduce local child_process spawn or Electron-host askpass env", async () => {
    const source = await fs.promises.readFile(
      path.join(process.cwd(), "src/main/git/git-clone.ts"),
      "utf8",
    );

    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain("buildHelperEnv");
    expect(source).not.toMatch(/\bspawn\s*\(/);
  });
});

describe("cloneStream", () => {
  it("obtains the requested workspace clone executor from GitRegistry", async () => {
    const parent = await makeTempDir();
    const executorCwd = path.join(parent, "workspace-root");
    await fs.promises.mkdir(executorCwd);
    const { executor, calls } = fakeExecutor(async function* () {
      yield Buffer.from("Receiving objects: 100% (1/1)\n");
    });
    const getCloneExecutionContext = mock((workspaceId?: string) => ({
      workspaceId: workspaceId ?? WORKSPACE_ID,
      bin: { path: "git", version: "agent" },
      cwd: executorCwd,
      executor,
    }));
    const handler = cloneStream({ getCloneExecutionContext } as unknown as GitRegistry);

    const result = await drainCloneStream(
      handler(
        {
          workspaceId: WORKSPACE_ID,
          url: "https://example.invalid/repo.git",
          destination: parent,
          name: "repo",
        },
        { signal: new AbortController().signal } as StreamContext,
      ),
    );

    expect(getCloneExecutionContext).toHaveBeenCalledWith(WORKSPACE_ID, parent);
    expect(calls[0]?.streamStderr).toBe(true);
    expect(calls[0]?.cwd).toBe(executorCwd);
    expect(result.progress.map((event) => event.kind)).toContain("started");
    expect(result.complete).toEqual({ kind: "complete", absPath: path.join(parent, "repo") });
  });
});

/** Creates a tracked temp directory for this test file. */
async function makeTempDir(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nexus-clone-test-"));
  tempRoots.push(root);
  return root;
}

/** Builds a minimal GitExecutor fake that records every stream call. */
function fakeExecutor(
  stream: (options: GitProcessOptions) => AsyncGenerator<Buffer, void, unknown>,
): { readonly executor: GitExecutor; readonly calls: GitProcessOptions[] } {
  const calls: GitProcessOptions[] = [];
  return {
    calls,
    executor: {
      async run(_options: RunGitOptions): Promise<never> {
        throw new Error("unexpected git run call");
      },
      async *stream(options: GitProcessOptions): AsyncGenerator<Buffer, void, unknown> {
        calls.push(options);
        yield* stream(options);
      },
    },
  };
}

/** Waits for an eventually true condition raised by the fake git executor. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}

/** Resolves when the provided signal is aborted. */
function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal?.addEventListener("abort", () => resolve(), { once: true }),
  );
}

/** Creates the standard AbortError shape returned by GitExecutor cancellation. */
function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/** Checks path existence without throwing on ENOENT. */
async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.promises.access(absPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Drains the clone IPC stream helper while preserving its terminal return. */
async function drainCloneStream(
  generator: AsyncGenerator<GitCloneStreamProgressEvent, GitCloneStreamResultEvent, unknown>,
): Promise<{
  readonly progress: GitCloneStreamProgressEvent[];
  readonly complete: GitCloneStreamResultEvent;
}> {
  const progress: GitCloneStreamProgressEvent[] = [];
  for (;;) {
    const next = await generator.next();
    if (next.done) return { progress, complete: next.value };
    progress.push(next.value);
  }
}
