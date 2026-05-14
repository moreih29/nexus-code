/**
 * GitRepository stash method tests.
 *
 * parseStashList / argv verification moved to Go fixture tests in
 * internal/git/stash_test.go. These tests verify that GitRepository routes
 * each stash operation through the queue and delegates to the typed executor
 * methods — not to git-stash.ts helpers.
 */
import { describe, expect, mock, test } from "bun:test";
import type {
  DiffChunk,
  DiffComplete,
  StashEntry,
} from "../../../../src/shared/types/git";
import { GitError } from "../../../../src/main/features/git/domain/git-error";
import type {
  GitExecutor,
  GitStashApplyOptions,
  GitStashDropOptions,
  GitStashGroupOptions,
  GitStashListOptions,
  GitStashPopOptions,
  GitStashShowOptions,
  RunGitOptions,
  RunGitResult,
  GitProcessOptions,
} from "../../../../src/main/features/git/bridge/types";
import { GitRepository } from "../../../../src/main/features/git/domain/git-repository";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

const fakeEntry: StashEntry = {
  index: 0,
  sha: "0123456789abcdef0123456789abcdef01234567",
  message: "save work",
  branch: "main",
  createdAt: 1_700_000_000_000,
};

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
// stashList
// ---------------------------------------------------------------------------

describe("GitRepository.listStashes", () => {
  test("delegates to executor.stashList and returns entries", async () => {
    const stashList = mock(
      (_options: GitStashListOptions): Promise<StashEntry[]> =>
        Promise.resolve([fakeEntry]),
    );
    const repo = makeRepo(makeExecutor({ stashList }));
    const result = await repo.listStashes();
    expect(result).toEqual([fakeEntry]);
    expect(stashList).toHaveBeenCalledTimes(1);
  });

  test("throws missingExecutorMethodError when stashList is absent", async () => {
    const repo = makeRepo(makeExecutor());
    await expect(repo.listStashes()).rejects.toThrow("stashList");
  });
});

// ---------------------------------------------------------------------------
// stashApply
// ---------------------------------------------------------------------------

describe("GitRepository.applyStash", () => {
  test("delegates to executor.stashApply with correct index", async () => {
    const stashApply = mock(
      (_options: GitStashApplyOptions): Promise<void> => Promise.resolve(),
    );
    const repo = makeRepo(makeExecutor({ stashApply }));
    await repo.applyStash(3);
    expect(stashApply).toHaveBeenCalledTimes(1);
    const call = stashApply.mock.calls[0]?.[0];
    expect(call?.index).toBe(3);
  });

  test("propagates stash-conflict GitError from executor", async () => {
    const stashApply = mock(
      (_options: GitStashApplyOptions): Promise<void> =>
        Promise.reject(new GitError("stash-conflict", "conflict", {})),
    );
    const repo = makeRepo(makeExecutor({ stashApply }));
    await expect(repo.applyStash(0)).rejects.toMatchObject({ kind: "stash-conflict" });
  });

  test("throws missingExecutorMethodError when stashApply is absent", async () => {
    const repo = makeRepo(makeExecutor());
    await expect(repo.applyStash(0)).rejects.toThrow("stashApply");
  });
});

// ---------------------------------------------------------------------------
// stashDrop
// ---------------------------------------------------------------------------

describe("GitRepository.dropStash", () => {
  test("delegates to executor.stashDrop with correct index", async () => {
    const stashDrop = mock(
      (_options: GitStashDropOptions): Promise<void> => Promise.resolve(),
    );
    const repo = makeRepo(makeExecutor({ stashDrop }));
    await repo.dropStash(1);
    expect(stashDrop).toHaveBeenCalledTimes(1);
    const call = stashDrop.mock.calls[0]?.[0];
    expect(call?.index).toBe(1);
  });

  test("throws missingExecutorMethodError when stashDrop is absent", async () => {
    const repo = makeRepo(makeExecutor());
    await expect(repo.dropStash(0)).rejects.toThrow("stashDrop");
  });
});

// ---------------------------------------------------------------------------
// stashPop
// ---------------------------------------------------------------------------

describe("GitRepository.stashPop", () => {
  test("delegates to executor.stashPop", async () => {
    const stashPop = mock(
      (_options: GitStashPopOptions): Promise<void> => Promise.resolve(),
    );
    const repo = makeRepo(makeExecutor({ stashPop }));
    await repo.stashPop();
    expect(stashPop).toHaveBeenCalledTimes(1);
  });

  test("propagates stash-conflict GitError from executor", async () => {
    const stashPop = mock(
      (_options: GitStashPopOptions): Promise<void> =>
        Promise.reject(new GitError("stash-conflict", "conflict", {})),
    );
    const repo = makeRepo(makeExecutor({ stashPop }));
    await expect(repo.stashPop()).rejects.toMatchObject({ kind: "stash-conflict" });
  });

  test("throws missingExecutorMethodError when stashPop is absent", async () => {
    const repo = makeRepo(makeExecutor());
    await expect(repo.stashPop()).rejects.toThrow("stashPop");
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

  test("throws missingExecutorMethodError when stashShow is absent", async () => {
    const repo = makeRepo(makeExecutor());
    const gen = repo.showStash(0);
    await expect(gen.next()).rejects.toThrow("stashShow");
  });
});

// ---------------------------------------------------------------------------
// stashGroup
// ---------------------------------------------------------------------------

describe("GitRepository.stashGroup", () => {
  test("delegates to executor.stashGroup with paths and message", async () => {
    const stashGroup = mock(
      (_options: GitStashGroupOptions): Promise<void> => Promise.resolve(),
    );
    const repo = makeRepo(makeExecutor({ stashGroup }));
    await repo.stashGroup(["a.ts", "b.ts"], "my stash");
    expect(stashGroup).toHaveBeenCalledTimes(1);
    const call = stashGroup.mock.calls[0]?.[0];
    expect(call?.paths).toEqual(["a.ts", "b.ts"]);
    expect(call?.message).toBe("my stash");
  });

  test("throws missingExecutorMethodError when stashGroup is absent", async () => {
    const repo = makeRepo(makeExecutor());
    await expect(repo.stashGroup(["a.ts"])).rejects.toThrow("stashGroup");
  });
});
