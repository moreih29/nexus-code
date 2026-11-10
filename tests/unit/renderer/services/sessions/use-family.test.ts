/**
 * The sessions tab's polling: one read at a time, none applied once stopped,
 * a worktree's changes kept through a failed read, and a family rebuilt to
 * the same kept as it was.
 */
import { describe, expect, it } from "bun:test";
import {
  mergeChanges,
  startPolling,
  type WorktreeChanges,
} from "../../../../../src/renderer/services/sessions/use-family";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("startPolling", () => {
  it("skips a tick while a read is still out", async () => {
    let started = 0;
    let release: () => void = () => {};
    const stop = startPolling(async () => {
      started++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }, 5);
    await wait(30);
    expect(started).toBe(1);
    release();
    await wait(15);
    expect(started).toBe(2);
    stop();
    release();
  });

  it("tells a read that answers after the stop that it is no longer wanted", async () => {
    let release: () => void = () => {};
    let latest: boolean | undefined;
    const stop = startPolling(async (isLatest) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      latest = isLatest();
    }, 1_000);
    stop();
    release();
    await wait(0);
    expect(latest).toBe(false);
  });

  it("keeps polling after a read throws", async () => {
    let reads = 0;
    const stop = startPolling(async () => {
      reads++;
      throw new Error("offline");
    }, 5);
    await wait(30);
    stop();
    expect(reads).toBeGreaterThan(1);
  });
});

describe("mergeChanges", () => {
  const a: WorktreeChanges = { branch: "main", files: [{ relPath: "a.ts", code: "M" }] };
  const b: WorktreeChanges = { branch: "task", files: [] };

  it("keeps a worktree's last changes when its read fails, and drops one no longer read", () => {
    const prev = new Map([
      ["a", a],
      ["gone", b],
    ]);
    const next = mergeChanges(prev, [
      ["a", undefined],
      ["b", b],
      ["never", undefined],
    ]);
    expect([...next]).toEqual([
      ["a", a],
      ["b", b],
    ]);
  });
});
