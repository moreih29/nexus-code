/**
 * GitRepository stash method tests.
 *
 * parseStashList / argv verification moved to Go fixture tests in
 * internal/git/stash_test.go. These tests verify that GitRepository routes
 * each stash operation through the queue and delegates to the typed executor
 * methods — not to git-stash.ts helpers.
 */
import { describe, expect, mock, test } from "bun:test";
import type { DiffChunk, DiffComplete } from "../../../../src/shared/git/types";
import type {
  GitExecutor,
  GitStashShowOptions,
  RunGitOptions,
  RunGitResult,
  GitProcessOptions,
} from "../../../../src/main/features/git/bridge/types";
import { GitRepository } from "../../../../src/main/features/git/domain/repository";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeExecutor(overrides: Partial<GitExecutor> = {}): GitExecutor {
  return {
    run(_options: RunGitOptions): Promise<RunGitResult> {
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
    async *stream(_options: GitProcessOptions): AsyncGenerator<Buffer, void, unknown> {
      // no-op
    },
    ...overrides,
  };
}

const stubMetadataReader = {
  metadata: (): never => {
    throw new Error("not implemented");
  },
  addToGitignore: (): never => {
    throw new Error("not implemented");
  },
};

function makeRepo(executor: GitExecutor): GitRepository {
  return new GitRepository(
    "ws-test",
    "/repo",
    "/repo/.git",
    "/usr/bin/git",
    executor,
    stubMetadataReader,
  );
}

// ---------------------------------------------------------------------------
// Promise-returning stash methods
// ---------------------------------------------------------------------------

describe("GitRepository stash delegation", () => {
  test.each([
    {
      name: "listStashes",
      executorMethod: "stashList",
      call: (repo: GitRepository) => repo.listStashes(),
      options: {},
      returnsResult: true,
    },
    {
      name: "applyStash",
      executorMethod: "stashApply",
      call: (repo: GitRepository) => repo.applyStash(3),
      options: { index: 3 },
      returnsResult: false,
    },
    {
      name: "dropStash",
      executorMethod: "stashDrop",
      call: (repo: GitRepository) => repo.dropStash(1),
      options: { index: 1 },
      returnsResult: false,
    },
    {
      name: "stashPop",
      executorMethod: "stashPop",
      call: (repo: GitRepository) => repo.stashPop(),
      options: {},
      returnsResult: false,
    },
    {
      name: "stashGroup",
      executorMethod: "stashGroup",
      call: (repo: GitRepository) => repo.stashGroup(["a.ts", "b.ts"], "my stash"),
      options: { paths: ["a.ts", "b.ts"], message: "my stash" },
      returnsResult: false,
    },
  ])("$name delegates to executor.$executorMethod", async (row) => {
    const executorResult = [{ from: row.executorMethod }];
    const method = mock((_options: unknown) => Promise.resolve(executorResult));
    const repo = makeRepo(makeExecutor({ [row.executorMethod]: method }));

    const result = await row.call(repo);

    if (row.returnsResult) expect(result).toBe(executorResult as never);
    expect(method).toHaveBeenCalledTimes(1);
    expect(method.mock.calls[0]?.[0]).toMatchObject({ cwd: "/repo", ...row.options });
  });
});

// ---------------------------------------------------------------------------
// stashShow
// ---------------------------------------------------------------------------

describe("GitRepository.showStash", () => {
  test("yields chunks and returns complete from executor.stashShow", async () => {
    const chunk: DiffChunk = { text: "diff --git a/f b/f\n" };
    const complete: DiffComplete = { bytes: 100, truncated: false };

    async function* fakeStashShow(
      _options: GitStashShowOptions,
    ): AsyncGenerator<DiffChunk, DiffComplete, unknown> {
      yield chunk;
      return complete;
    }

    const repo = makeRepo(makeExecutor({ stashShow: fakeStashShow }));
    const chunks: DiffChunk[] = [];
    let returnValue: DiffComplete | undefined;

    const gen = repo.showStash(0);
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        returnValue = next.value as DiffComplete;
        break;
      }
      chunks.push(next.value);
    }

    expect(chunks).toEqual([chunk]);
    expect(returnValue).toEqual(complete);
  });
});
