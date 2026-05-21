/**
 * Unit tests for the applySortedInsert pure function.
 *
 * The function inserts a workspace into the correct sorted position within a
 * list ordered by: pinned DESC, group-specific order column ASC.
 * It also returns `consistent=false` when the inserted item's sort key
 * conflicts with an immediate neighbour (indicating a stale store state).
 */

import { describe, expect, it } from "bun:test";
import { applySortedInsert } from "../../../../../src/renderer/state/stores/workspaces";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function nextId(): string {
  _seq += 1;
  return `00000000-0000-4000-8000-${String(_seq).padStart(12, "0")}`;
}

function makeWs(overrides: Partial<WorkspaceMeta> = {}): WorkspaceMeta {
  return {
    id: nextId(),
    name: "ws",
    rootPath: "/r",
    location: { kind: "local", rootPath: "/r" },
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date().toISOString(),
    tabs: [],
    sortOrder: 0,
    pinnedSortOrder: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Same-group insertion (unpinned)
// ---------------------------------------------------------------------------

describe("applySortedInsert — unpinned group positioning", () => {
  it("inserts at the top when sortOrder is smallest", () => {
    const a = makeWs({ sortOrder: 2048 });
    const b = makeWs({ sortOrder: 3072 });
    const meta = makeWs({ sortOrder: 1024 });

    const { workspaces, consistent } = applySortedInsert([a, b], meta);

    expect(workspaces.map((w) => w.id)).toEqual([meta.id, a.id, b.id]);
    expect(consistent).toBe(true);
  });

  it("inserts in the middle when sortOrder falls between two items", () => {
    const a = makeWs({ sortOrder: 1024 });
    const b = makeWs({ sortOrder: 3072 });
    const meta = makeWs({ sortOrder: 2048 });

    const { workspaces, consistent } = applySortedInsert([a, b], meta);

    expect(workspaces.map((w) => w.id)).toEqual([a.id, meta.id, b.id]);
    expect(consistent).toBe(true);
  });

  it("appends at the tail when sortOrder is largest", () => {
    const a = makeWs({ sortOrder: 1024 });
    const b = makeWs({ sortOrder: 2048 });
    const meta = makeWs({ sortOrder: 4096 });

    const { workspaces, consistent } = applySortedInsert([a, b], meta);

    expect(workspaces[2].id).toBe(meta.id);
    expect(consistent).toBe(true);
  });

  it("removes the existing entry for meta.id before re-inserting", () => {
    const meta = makeWs({ sortOrder: 1024 });
    const b = makeWs({ sortOrder: 2048 });
    // Stale copy of meta at a different position
    const stale = { ...meta, sortOrder: 3072 };

    const { workspaces } = applySortedInsert([stale, b], meta);

    const ids = workspaces.map((w) => w.id);
    // Only one entry for meta.id
    expect(ids.filter((id) => id === meta.id).length).toBe(1);
    // meta (1024) now precedes b (2048)
    expect(workspaces[0].id).toBe(meta.id);
    expect(workspaces[1].id).toBe(b.id);
  });

  it("works correctly on a single-item list (top)", () => {
    const a = makeWs({ sortOrder: 2048 });
    const meta = makeWs({ sortOrder: 1024 });
    const { workspaces, consistent } = applySortedInsert([a], meta);
    expect(workspaces[0].id).toBe(meta.id);
    expect(consistent).toBe(true);
  });

  it("works correctly on a single-item list (tail)", () => {
    const a = makeWs({ sortOrder: 1024 });
    const meta = makeWs({ sortOrder: 2048 });
    const { workspaces, consistent } = applySortedInsert([a], meta);
    expect(workspaces[1].id).toBe(meta.id);
    expect(consistent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Same-group insertion (pinned)
// ---------------------------------------------------------------------------

describe("applySortedInsert — pinned group positioning", () => {
  it("pinned rows sort before all unpinned rows", () => {
    const unpinned = makeWs({ sortOrder: 1024 });
    const meta = makeWs({ pinned: true, pinnedSortOrder: 1024 });

    const { workspaces, consistent } = applySortedInsert([unpinned], meta);

    expect(workspaces[0].id).toBe(meta.id);
    expect(workspaces[1].id).toBe(unpinned.id);
    expect(consistent).toBe(true);
  });

  it("pinned rows are ordered by pinnedSortOrder ascending among themselves", () => {
    const p1 = makeWs({ pinned: true, pinnedSortOrder: 1024 });
    const p2 = makeWs({ pinned: true, pinnedSortOrder: 3072 });
    const meta = makeWs({ pinned: true, pinnedSortOrder: 2048 });

    const { workspaces, consistent } = applySortedInsert([p1, p2], meta);

    expect(workspaces.map((w) => w.id)).toEqual([p1.id, meta.id, p2.id]);
    expect(consistent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-group move
// ---------------------------------------------------------------------------

describe("applySortedInsert — cross-group move", () => {
  it("unpinned → pinned: new item lands above all unpinned rows", () => {
    const u1 = makeWs({ sortOrder: 1024 });
    const u2 = makeWs({ sortOrder: 2048 });
    const meta = makeWs({ pinned: true, pinnedSortOrder: 1024, sortOrder: 0 });

    const { workspaces, consistent } = applySortedInsert([u1, u2], meta);

    expect(workspaces[0].id).toBe(meta.id);
    expect(consistent).toBe(true);
  });

  it("pinned → unpinned: new item lands below all pinned rows", () => {
    const p1 = makeWs({ pinned: true, pinnedSortOrder: 1024 });
    const meta = makeWs({ pinned: false, sortOrder: 1024, pinnedSortOrder: 0 });

    const { workspaces, consistent } = applySortedInsert([p1], meta);

    expect(workspaces[0].id).toBe(p1.id);
    expect(workspaces[1].id).toBe(meta.id);
    expect(consistent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sort-field-unchanged update (hot-path: no positional change)
// ---------------------------------------------------------------------------

describe("applySortedInsert — sort fields unchanged", () => {
  it("updates non-sort field without changing list order", () => {
    const a = makeWs({ sortOrder: 1024 });
    const meta = makeWs({ sortOrder: 2048, name: "original" });
    const b = makeWs({ sortOrder: 3072 });

    const renamed = { ...meta, name: "renamed" };
    const { workspaces, consistent } = applySortedInsert([a, meta, b], renamed);

    expect(workspaces[1].id).toBe(meta.id);
    expect(workspaces[1].name).toBe("renamed");
    expect(consistent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Neighbour inconsistency detection
// ---------------------------------------------------------------------------

describe("applySortedInsert — neighbour inconsistency", () => {
  it("returns consistent=false when meta shares the exact same sort key as its left neighbour", () => {
    // Two workspaces at the same position indicate a missed rebalance broadcast.
    const existing = makeWs({ sortOrder: 2048 });
    const meta = makeWs({ sortOrder: 2048 }); // same position → tie

    const { consistent } = applySortedInsert([existing], meta);

    // After insertion: [existing=2048, meta=2048]. Left neighbour key = [1,2048]
    // which equals meta key [1,2048] — the strict-greater check fires.
    expect(consistent).toBe(false);
  });

  it("returns consistent=false when meta shares the exact same sort key as its right neighbour", () => {
    // meta comes before existing because binary search places it first,
    // then existing (with the same key) appears to the right.
    const existing = makeWs({ sortOrder: 1024 });
    const meta = makeWs({ sortOrder: 1024 }); // tie with existing

    const { consistent } = applySortedInsert([existing], meta);
    expect(consistent).toBe(false);
  });

  it("returns consistent=true for a correctly ordered insertion", () => {
    const a = makeWs({ sortOrder: 1024 });
    const b = makeWs({ sortOrder: 3072 });
    const meta = makeWs({ sortOrder: 2048 });

    const { consistent } = applySortedInsert([a, b], meta);
    expect(consistent).toBe(true);
  });
});
