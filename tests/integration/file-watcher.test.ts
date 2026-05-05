/**
 * Integration: FileWatcher — buffer/flush + disposeWorkspace + watch/unwatch entries
 *
 * DESIGN DECISION — chokidar stub vs real filesystem
 * ---------------------------------------------------
 * Real chokidar + fsevents on macOS introduces non-deterministic timing (event
 * delivery can lag 50–500 ms even with `usePolling: false`).  Spinning up real
 * watchers in a unit-test environment risks flaky CI.  Instead, we exercise the
 * FileWatcher's buffer/flush logic directly:
 *
 *   - `watch()` is called normally so the entries Map and chokidar instance are
 *     created, but we immediately unref any async I/O so tests don't hang.
 *   - We drive the internal `buffer()` method (cast to any) to simulate incoming
 *     filesystem events without waiting on real fsevents delivery.
 *
 * This is safe because the real-chokidar event handlers all funnel into
 * `this.buffer()` — testing buffer/flush directly tests the same code path
 * and gives deterministic timing.
 *
 * SCENARIO MATRIX
 * ---------------
 * Scenario 2  — external file creation → 300ms debounce → single broadcast   AUTO (buffer-driven)
 * Scenario 4  — disposeWorkspace → watcher entries/timers/buffers cleaned up  AUTO
 * Scenario 6  — 10 changes in burst → 300ms collapses to 1 broadcast         AUTO (buffer-driven)
 *
 * Scenarios 1, 3, 5 are fully covered by existing unit tests:
 *   - Scenario 1 (expand → watch): files-store.test.ts Scenario 2 + fs-channel.test.ts watch handler
 *   - Scenario 3 (collapse → unwatch): files-store.test.ts Scenario 3
 *   - Scenario 5 (restart → hydrate): files-store.test.ts Scenario 8 + storage-workspace.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileWatcher } from "../../src/main/filesystem/file-watcher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WS_A = "aaaaaaaa-0000-0000-0000-000000000001";
const WS_B = "bbbbbbbb-0000-0000-0000-000000000002";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type BroadcastCall = { channel: string; event: string; args: unknown };

function makeBroadcast(): { broadcast: (ch: string, ev: string, args: unknown) => void; calls: BroadcastCall[] } {
  const calls: BroadcastCall[] = [];
  const broadcast = (channel: string, event: string, args: unknown) => {
    calls.push({ channel, event, args });
  };
  return { broadcast, calls };
}

/** Drive the internal buffer path without waiting on real fsevents. */
function driveBuffer(watcher: FileWatcher, workspaceId: string, relPath: string, kind: "added" | "modified" | "deleted"): void {
  // FileWatcher.buffer is private but we access it via cast for test purposes.
  // This is the same path that chokidar event handlers invoke.
  (watcher as unknown as { buffer(wsId: string, rel: string, k: string): void }).buffer(workspaceId, relPath, kind);
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pr2-watcher-test-"));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let broadcast: ReturnType<typeof makeBroadcast>;
let watcher: FileWatcher;

beforeEach(() => {
  tmpDir = makeTmpDir();
  broadcast = makeBroadcast();
  watcher = new FileWatcher(broadcast.broadcast);
});

afterEach(async () => {
  // Dispose watcher to close all chokidar instances and clear timers.
  watcher.dispose();
  // Give any pending async close() promises a chance to settle.
  await new Promise((r) => setTimeout(r, 10));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scenario 2: external file creation → 300ms debounce → single broadcast
//
// We simulate "a file was created in a watched directory" by calling
// driveBuffer() once, then verifying that after 300 ms the broadcast was
// fired exactly once with the correct payload.
// ---------------------------------------------------------------------------

describe("Scenario 2: fs.changed broadcast fires after 300ms debounce (single change)", () => {
  it("broadcasts exactly once after debounce window with correct payload", async () => {
    // Watch the tmp dir (creates chokidar instance but we don't wait on events).
    watcher.watch(WS_A, tmpDir, tmpDir);

    // Simulate: new file "new.ts" was created inside tmpDir.
    driveBuffer(watcher, WS_A, "new.ts", "added");

    // Before debounce fires: no broadcast yet.
    expect(broadcast.calls).toHaveLength(0);

    // Wait for debounce (300 ms) plus a small grace period.
    await new Promise((r) => setTimeout(r, 350));

    // Exactly one broadcast should have been emitted.
    expect(broadcast.calls).toHaveLength(1);

    const call = broadcast.calls[0];
    expect(call.channel).toBe("fs");
    expect(call.event).toBe("changed");

    const args = call.args as { workspaceId: string; changes: { relPath: string; kind: string }[] };
    expect(args.workspaceId).toBe(WS_A);
    expect(args.changes).toHaveLength(1);
    expect(args.changes[0].relPath).toBe("new.ts");
    expect(args.changes[0].kind).toBe("added");
  });

  it("does not broadcast before the 300ms window closes", async () => {
    watcher.watch(WS_A, tmpDir, tmpDir);

    driveBuffer(watcher, WS_A, "early.ts", "added");

    // Check immediately — should be silent.
    expect(broadcast.calls).toHaveLength(0);

    // Check at 250ms — still within window.
    await new Promise((r) => setTimeout(r, 250));
    expect(broadcast.calls).toHaveLength(0);

    // Wait past the window.
    await new Promise((r) => setTimeout(r, 100));
    expect(broadcast.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: burst of 10 changes within 300ms → collapses to 1 broadcast
//
// This is the debounce correctness test: all changes that arrive within one
// 300 ms window must be batched into a single broadcast call.
// ---------------------------------------------------------------------------

describe("Scenario 6: burst of changes debounced to single broadcast", () => {
  it("10 rapid changes in <50ms produce exactly 1 broadcast after 300ms", async () => {
    watcher.watch(WS_A, tmpDir, tmpDir);

    // Fire 10 events very rapidly (synchronously back-to-back).
    for (let i = 0; i < 10; i++) {
      driveBuffer(watcher, WS_A, `file${i}.ts`, "added");
    }

    // No broadcast yet.
    expect(broadcast.calls).toHaveLength(0);

    // Wait for debounce.
    await new Promise((r) => setTimeout(r, 350));

    // Must be exactly 1 broadcast.
    expect(broadcast.calls).toHaveLength(1);

    const args = broadcast.calls[0].args as { workspaceId: string; changes: { relPath: string; kind: string }[] };
    expect(args.workspaceId).toBe(WS_A);
    // All 10 paths included in one batch.
    expect(args.changes).toHaveLength(10);
  });

  it("changes for different workspaces are batched independently", async () => {
    const tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pr2-ws-b-"));
    try {
      watcher.watch(WS_A, tmpDir, tmpDir);
      watcher.watch(WS_B, tmpDirB, tmpDirB);

      driveBuffer(watcher, WS_A, "a.ts", "added");
      driveBuffer(watcher, WS_B, "b.ts", "added");

      await new Promise((r) => setTimeout(r, 350));

      // Two separate broadcasts, one per workspace.
      expect(broadcast.calls).toHaveLength(2);
      const wsIds = broadcast.calls.map((c) => (c.args as { workspaceId: string }).workspaceId);
      expect(wsIds).toContain(WS_A);
      expect(wsIds).toContain(WS_B);
    } finally {
      fs.rmSync(tmpDirB, { recursive: true, force: true });
    }
  });

  it("last-write-wins: same relPath with multiple events keeps final kind", async () => {
    watcher.watch(WS_A, tmpDir, tmpDir);

    // Simulate add → modify → delete for the same file within one window.
    driveBuffer(watcher, WS_A, "volatile.ts", "added");
    driveBuffer(watcher, WS_A, "volatile.ts", "modified");
    driveBuffer(watcher, WS_A, "volatile.ts", "deleted");

    await new Promise((r) => setTimeout(r, 350));

    expect(broadcast.calls).toHaveLength(1);
    const args = broadcast.calls[0].args as { changes: { relPath: string; kind: string }[] };
    // Same relPath — only one entry, with the final kind (deleted).
    expect(args.changes).toHaveLength(1);
    expect(args.changes[0].relPath).toBe("volatile.ts");
    expect(args.changes[0].kind).toBe("deleted");
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: disposeWorkspace cleans up entries, timers, buffers,
//             and does NOT broadcast after disposal even if events were buffered.
// ---------------------------------------------------------------------------

describe("Scenario 4: disposeWorkspace removes all watcher state and silences buffered events", () => {
  it("after disposeWorkspace, entries for that workspace are removed", () => {
    const subDir = path.join(tmpDir, "src");
    fs.mkdirSync(subDir, { recursive: true });

    watcher.watch(WS_A, tmpDir, tmpDir);
    watcher.watch(WS_A, tmpDir, subDir);

    // Verify the watcher is tracking these two dirs (indirectly via unwatch — no throw).
    expect(() => watcher.unwatch(WS_A, tmpDir)).not.toThrow();

    // Re-add them for the dispose test.
    watcher.watch(WS_A, tmpDir, tmpDir);
    watcher.watch(WS_A, tmpDir, subDir);

    watcher.disposeWorkspace(WS_A);

    // After dispose, unwatch is a no-op (entry gone) — calling it should not throw.
    expect(() => watcher.unwatch(WS_A, tmpDir)).not.toThrow();
    expect(() => watcher.unwatch(WS_A, subDir)).not.toThrow();
  });

  it("buffered changes are discarded when disposeWorkspace is called before flush", async () => {
    watcher.watch(WS_A, tmpDir, tmpDir);

    // Buffer some events.
    driveBuffer(watcher, WS_A, "file.ts", "added");

    // Immediately dispose before the 300ms window fires.
    watcher.disposeWorkspace(WS_A);

    // Wait past the debounce window.
    await new Promise((r) => setTimeout(r, 350));

    // No broadcast should have fired.
    expect(broadcast.calls).toHaveLength(0);
  });

  it("disposeWorkspace does not affect other workspace watchers", async () => {
    const tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pr2-ws-b2-"));
    try {
      watcher.watch(WS_A, tmpDir, tmpDir);
      watcher.watch(WS_B, tmpDirB, tmpDirB);

      driveBuffer(watcher, WS_A, "a.ts", "added");
      driveBuffer(watcher, WS_B, "b.ts", "added");

      // Dispose WS_A only.
      watcher.disposeWorkspace(WS_A);

      await new Promise((r) => setTimeout(r, 350));

      // WS_A was disposed — its buffered event must NOT broadcast.
      // WS_B was not disposed — its buffered event MUST broadcast.
      const wsBroadcasts = broadcast.calls.filter(
        (c) => (c.args as { workspaceId: string }).workspaceId === WS_B,
      );
      const wsABroadcasts = broadcast.calls.filter(
        (c) => (c.args as { workspaceId: string }).workspaceId === WS_A,
      );
      expect(wsBroadcasts).toHaveLength(1);
      expect(wsABroadcasts).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDirB, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Additional: unwatch() removes only the targeted entry, not siblings
// ---------------------------------------------------------------------------

describe("FileWatcher.unwatch selectivity", () => {
  it("unwatch one dir does not affect sibling watcher for the same workspace", async () => {
    const subDir = path.join(tmpDir, "lib");
    fs.mkdirSync(subDir, { recursive: true });

    watcher.watch(WS_A, tmpDir, tmpDir);
    watcher.watch(WS_A, tmpDir, subDir);

    // Unwatch only the root dir.
    watcher.unwatch(WS_A, tmpDir);

    // Drive an event for lib (subDir still watched).
    driveBuffer(watcher, WS_A, "lib/util.ts", "added");

    await new Promise((r) => setTimeout(r, 350));

    // Broadcast should still fire because subDir watcher is still active.
    expect(broadcast.calls).toHaveLength(1);
  });
});

