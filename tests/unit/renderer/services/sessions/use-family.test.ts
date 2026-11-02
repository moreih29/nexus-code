/**
 * The sessions tab's polling: one read at a time, none applied once stopped,
 * a worktree's changes kept through a failed read, and a family rebuilt to
 * the same kept as it was.
 */
import { describe, expect, it } from "bun:test";
import { buildFamily, sameFamily } from "../../../../../src/renderer/services/sessions/model";
import {
  mergeChanges,
  startPolling,
  type WorktreeChanges,
} from "../../../../../src/renderer/services/sessions/use-family";
import type { Tab } from "../../../../../src/renderer/state/stores/tabs";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

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

describe("sameFamily", () => {
  const root = {
    id: "r",
    name: "app",
    location: { kind: "local", rootPath: "/r" },
    rootPath: "/r",
    tabs: [],
  } as unknown as WorkspaceMeta;
  const tab = (title: string) =>
    ({ id: "t", type: "terminal", title, props: { cwd: "/" } }) as unknown as Tab;
  const build = (title: string, lastOutputAt: number, now: number) =>
    buildFamily({
      workspaces: [root],
      workspaceId: "r",
      tabsByWorkspace: { r: { t: tab(title) } },
      claudeByWorkspace: {},
      activity: new Map([["r:t", { lastOutputAt }]]),
      now,
    });

  it("is the same for a rebuild that shows the same, and not for a changed state", () => {
    expect(sameFamily(build("codex", 0, 10_000), build("codex", 0, 20_000))).toBe(true);
    // Printing again: busy, not quiet.
    expect(sameFamily(build("codex", 0, 10_000), build("codex", 19_500, 20_000))).toBe(false);
    expect(sameFamily(build("codex", 0, 10_000), build("codex · 2", 0, 10_000))).toBe(false);
    expect(sameFamily(null, null)).toBe(true);
    expect(sameFamily(build("codex", 0, 10_000), null)).toBe(false);
  });
});
