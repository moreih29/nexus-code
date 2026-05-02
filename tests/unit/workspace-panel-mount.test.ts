/**
 * Regression guard — workspace panel mount/prune logic
 *
 * The `mountedIds` state in App.tsx implements two critical invariants that
 * prevent terminal input-line corruption on workspace switch:
 *
 *   1. Lazy-mount: a panel is added to mountedIds only when its workspace is
 *      first activated (never pre-mounted speculatively).
 *   2. One-way mount: switching away from a workspace does NOT remove it from
 *      mountedIds — the panel stays mounted (CSS-hidden) so its PTY survives.
 *   3. Prune on deletion: when a workspace is removed from the workspace list,
 *      its entry is purged from mountedIds so the panel unmounts and the PTY
 *      cleanup runs.
 *
 * These tests exercise the pure state-transition functions extracted from
 * App.tsx so they can run without a DOM/Electron environment.
 */

import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Pure state helpers — mirrors the logic in App.tsx useEffects.
// These are extracted for testability; any change to App.tsx that breaks these
// semantics must update these tests.
// ---------------------------------------------------------------------------

/** Mirrors: setMountedIds((prev) => { if (prev.has(id)) return prev; ... }) */
function activateWorkspace(mounted: Set<string>, id: string): Set<string> {
  if (mounted.has(id)) return mounted; // idempotent — same ref
  const next = new Set(mounted);
  next.add(id);
  return next;
}

/**
 * Mirrors: setMountedIds((prev) => { const alive = new Set(workspaces.map...); ... })
 * Returns the pruned set; returns the *same* Set reference when nothing changed.
 */
function pruneDeletedWorkspaces(mounted: Set<string>, aliveIds: string[]): Set<string> {
  const alive = new Set(aliveIds);
  let changed = false;
  const next = new Set<string>();
  for (const id of mounted) {
    if (alive.has(id)) {
      next.add(id);
    } else {
      changed = true;
    }
  }
  return changed ? next : mounted;
}

/** Mirrors: workspaces.filter((w) => mountedIds.has(w.id)) */
function mountedWorkspaces(workspaces: { id: string }[], mounted: Set<string>): { id: string }[] {
  return workspaces.filter((w) => mounted.has(w.id));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mountedIds — lazy-mount invariant", () => {
  it("adds workspace to mounted set on first activation", () => {
    const initial = new Set<string>();
    const next = activateWorkspace(initial, "ws-a");

    expect(next.has("ws-a")).toBe(true);
    expect(next).not.toBe(initial); // new reference
  });

  it("returns same Set reference when workspace is already mounted (idempotency)", () => {
    const initial = new Set(["ws-a"]);
    const result = activateWorkspace(initial, "ws-a");

    expect(result).toBe(initial); // same reference — no unnecessary re-render
  });

  it("does not mount workspace B when only workspace A is activated", () => {
    const initial = new Set<string>();
    const next = activateWorkspace(initial, "ws-a");

    expect(next.has("ws-b")).toBe(false);
  });
});

describe("mountedIds — one-way mount (panels survive workspace switch)", () => {
  it("switching active workspace does not remove previously mounted workspaces", () => {
    // Simulate: activate ws-a, then switch to ws-b
    let mounted = new Set<string>();
    mounted = activateWorkspace(mounted, "ws-a");
    mounted = activateWorkspace(mounted, "ws-b");

    // Both remain mounted regardless of which is "active"
    expect(mounted.has("ws-a")).toBe(true);
    expect(mounted.has("ws-b")).toBe(true);
  });

  it("mounting 3 workspaces in rapid succession preserves all", () => {
    let mounted = new Set<string>();
    for (const id of ["ws-1", "ws-2", "ws-3"]) {
      mounted = activateWorkspace(mounted, id);
    }

    expect(mounted.size).toBe(3);
    expect(mounted.has("ws-1")).toBe(true);
    expect(mounted.has("ws-2")).toBe(true);
    expect(mounted.has("ws-3")).toBe(true);
  });
});

describe("mountedIds — prune on workspace deletion", () => {
  it("removes deleted workspace from mounted set", () => {
    const mounted = new Set(["ws-a", "ws-b", "ws-c"]);
    const alive = ["ws-a", "ws-c"]; // ws-b deleted

    const next = pruneDeletedWorkspaces(mounted, alive);

    expect(next.has("ws-b")).toBe(false);
    expect(next.has("ws-a")).toBe(true);
    expect(next.has("ws-c")).toBe(true);
  });

  it("returns same Set reference when no workspaces were deleted", () => {
    const mounted = new Set(["ws-a", "ws-b"]);
    const alive = ["ws-a", "ws-b"];

    const result = pruneDeletedWorkspaces(mounted, alive);

    expect(result).toBe(mounted); // no unnecessary re-render
  });

  it("returns empty set when all workspaces are deleted", () => {
    const mounted = new Set(["ws-a", "ws-b"]);
    const alive: string[] = [];

    const result = pruneDeletedWorkspaces(mounted, alive);

    expect(result.size).toBe(0);
    expect(result).not.toBe(mounted);
  });

  it("is a no-op when mounted set is already empty", () => {
    const mounted = new Set<string>();
    const result = pruneDeletedWorkspaces(mounted, ["ws-a"]);

    expect(result).toBe(mounted);
    expect(result.size).toBe(0);
  });
});

describe("mountedWorkspaces — render gate", () => {
  it("renders only panels whose workspace is in mountedIds", () => {
    const workspaces = [{ id: "ws-a" }, { id: "ws-b" }, { id: "ws-c" }];
    const mounted = new Set(["ws-a", "ws-c"]); // ws-b not yet activated

    const rendered = mountedWorkspaces(workspaces, mounted);

    expect(rendered.map((w) => w.id)).toEqual(["ws-a", "ws-c"]);
  });

  it("returns empty array when no workspaces have been activated", () => {
    const workspaces = [{ id: "ws-a" }, { id: "ws-b" }];
    const mounted = new Set<string>();

    expect(mountedWorkspaces(workspaces, mounted)).toHaveLength(0);
  });

  it("deleted workspace panel disappears after prune even if it was previously mounted", () => {
    const workspaces = [{ id: "ws-a" }]; // ws-b deleted from workspaces list
    let mounted = new Set(["ws-a", "ws-b"]);
    mounted = pruneDeletedWorkspaces(
      mounted,
      workspaces.map((w) => w.id),
    );

    const rendered = mountedWorkspaces(workspaces, mounted);

    expect(rendered.map((w) => w.id)).toEqual(["ws-a"]);
    // Critically: ws-b is gone — its TerminalView cleanup (PTY kill) runs
    expect(mounted.has("ws-b")).toBe(false);
  });
});
