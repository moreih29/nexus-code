/**
 * Unit tests for the lock-busy retry layer in `git-process.ts`.
 *
 * `runGit` wraps the underlying single-shot invocation with `withLockRetry`
 * so transient `.git/index.lock` contention does not bubble up as a
 * permanent failure. Each test exercises the retry loop with a stub
 * attempt callback so the tests stay deterministic and avoid spawning
 * real git processes.
 */

import { describe, expect, test } from "bun:test";
import { GitError } from "../../../../src/main/git/git-error";
import { withLockRetry } from "../../../../src/main/git/git-process";

const NO_BACKOFF = (): number => 0;

function lockBusyError(): GitError {
  return new GitError("lock-busy", "Another git process seems to be running");
}

function nonRetryableError(): GitError {
  return new GitError("conflict", "merge conflict");
}

describe("withLockRetry", () => {
  test("returns the attempt's value on the first try when it succeeds", async () => {
    let calls = 0;
    const result = await withLockRetry(
      async () => {
        calls += 1;
        return "ok" as const;
      },
      { backoffMs: NO_BACKOFF },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  test("retries past one lock-busy failure and returns the second result", async () => {
    let calls = 0;
    const result = await withLockRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw lockBusyError();
        return calls;
      },
      { backoffMs: NO_BACKOFF },
    );

    expect(result).toBe(2);
    expect(calls).toBe(2);
  });

  test("gives up after maxAttempts and throws the last lock-busy error", async () => {
    let calls = 0;
    const promise = withLockRetry(
      async () => {
        calls += 1;
        throw lockBusyError();
      },
      { backoffMs: NO_BACKOFF, maxAttempts: 4 },
    );

    await expect(promise).rejects.toMatchObject({ kind: "lock-busy" });
    expect(calls).toBe(4);
  });

  test("does not retry non-lock errors — propagates immediately", async () => {
    let calls = 0;
    const promise = withLockRetry(
      async () => {
        calls += 1;
        throw nonRetryableError();
      },
      { backoffMs: NO_BACKOFF, maxAttempts: 5 },
    );

    await expect(promise).rejects.toMatchObject({ kind: "conflict" });
    expect(calls).toBe(1);
  });

  test("aborting between attempts throws AbortError without re-running", async () => {
    const controller = new AbortController();
    let calls = 0;
    const promise = withLockRetry(
      async () => {
        calls += 1;
        // Fire the abort right after the first failure registers; the next
        // iteration's pre-check should observe it before sleeping.
        controller.abort();
        throw lockBusyError();
      },
      { backoffMs: NO_BACKOFF, signal: controller.signal, maxAttempts: 5 },
    );

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  test("aborting an already-pending backoff cancels the wait", async () => {
    const controller = new AbortController();
    let calls = 0;
    const promise = withLockRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          // Schedule an abort during the backoff window of the second
          // attempt. The retry should reject with AbortError and never
          // re-enter the attempt callback.
          setTimeout(() => controller.abort(), 5);
          throw lockBusyError();
        }
        return "should-not-reach";
      },
      { backoffMs: () => 1000, signal: controller.signal, maxAttempts: 5 },
    );

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  test("rejecting with a non-Error value still propagates without retry", async () => {
    let calls = 0;
    const promise = withLockRetry(
      async () => {
        calls += 1;
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "not-a-git-error";
      },
      { backoffMs: NO_BACKOFF },
    );

    await expect(promise).rejects.toBe("not-a-git-error");
    expect(calls).toBe(1);
  });
});
