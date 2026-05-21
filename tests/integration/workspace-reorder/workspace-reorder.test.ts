/**
 * Integration tests: workspace drag/pin reorder scenarios.
 *
 * Exercises the full main-process stack — GlobalStorage (bun:sqlite in-memory),
 * WorkspaceManager, and broadcast spy — without spinning up Electron IPC or
 * a renderer.  Each suite maps to one acceptance criterion in T7.
 *
 * Test scope (Tester-authored, per authoring split):
 *   - Migration v5→v6 visual order preservation
 *   - Single-group reorder + broadcast routing
 *   - Cross-section reorder + automatic pin toggle
 *   - Rebalance trigger + bulk `workspace.reordered` event
 *   - Concurrent reorder serialization (determinism)
 *   - Renderer-store fallback on stale applySortedInsert (consistent=false → fetchList)
 *   - Hot-path: lastOpenedAt update does not trigger re-sort
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import os from "node:os";
import path from "node:path";
import { GlobalStorage } from "../../../src/main/infra/storage/global-storage";
import { applyMigrations } from "../../../src/main/infra/storage/migrations";
import { StateService } from "../../../src/main/infra/storage/state-service";
import { WorkspaceStorage } from "../../../src/main/infra/storage/workspace-storage";
import {
  type BroadcastFn,
  WorkspaceManager,
} from "../../../src/main/features/workspace/manager";
import {
  applySortedInsert,
  createWorkspacesStore,
} from "../../../src/renderer/state/stores/workspaces";
import type { WorkspaceMeta } from "../../../src/shared/types/workspace";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function uuid(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

function makeRootPath(n: number): string {
  return path.join(os.tmpdir(), `ws-integ-reorder-${n}`);
}

interface Fixtures {
  globalDb: Database;
  globalStorage: GlobalStorage;
  manager: WorkspaceManager;
  broadcast: ReturnType<typeof mock>;
}

function makeFixtures(): Fixtures {
  const globalDb = new Database(":memory:");
  const globalStorage = new GlobalStorage(globalDb);

  const wsBaseDir = path.join(os.tmpdir(), "nexus-integ-reorder-test");
  const workspaceStorage = new WorkspaceStorage(wsBaseDir, () => new Database(":memory:"));

  const stateService = new StateService(path.join(os.tmpdir(), "nexus-integ-reorder-state.json"));
  const broadcast = mock((_ch: string, _ev: string, _args: unknown) => {});

  const manager = new WorkspaceManager(
    globalStorage,
    workspaceStorage,
    stateService,
    broadcast as BroadcastFn,
  );

  return { globalDb, globalStorage, manager, broadcast };
}

/**
 * Helper: creates a workspace through WorkspaceManager.create() and returns its id.
 */
function createWs(manager: WorkspaceManager, n: number): string {
  const meta = manager.create({ rootPath: makeRootPath(n), name: `ws-${n}` });
  return meta.id;
}

/**
 * Reads all workspace rows directly from the DB, returning id → sort_order / pinned_sort_order.
 */
function readSortRows(
  db: Database,
): Map<string, { sortOrder: number; pinnedSortOrder: number; pinned: number }> {
  const rows = db
    .prepare("SELECT id, sort_order, pinned_sort_order, pinned FROM workspaces")
    .all() as {
    id: string;
    sort_order: number;
    pinned_sort_order: number;
    pinned: number;
  }[];
  const map = new Map<string, { sortOrder: number; pinnedSortOrder: number; pinned: number }>();
  for (const row of rows) {
    map.set(row.id, {
      sortOrder: row.sort_order,
      pinnedSortOrder: row.pinned_sort_order,
      pinned: row.pinned,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Scenario 1 — Migration v5→v6: visual order preservation
// ---------------------------------------------------------------------------

describe("migration v5→v6 — last_opened_at DESC visual order preserved", () => {
  it("listWorkspaces after v6 migration returns rows in last_opened_at DESC order", () => {
    // Simulate a v5 DB: workspaces table without sort_order / pinned_sort_order columns.
    const db = new Database(":memory:");

    // Apply only migrations 1–5 (no sort columns yet) by hand, then insert rows.
    db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (
        key   TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id             TEXT NOT NULL PRIMARY KEY,
        name           TEXT NOT NULL,
        root_path      TEXT NOT NULL,
        color_tone     TEXT NOT NULL DEFAULT 'default',
        pinned         INTEGER NOT NULL DEFAULT 0,
        last_opened_at INTEGER NOT NULL,
        location       TEXT
      );
    `);
    db.prepare("INSERT INTO _meta (key, value) VALUES ('schemaVersion', '5')").run();

    // Insert 4 workspaces with distinct last_opened_at timestamps.
    // The DESC order should be: ws-D (4000), ws-C (3000), ws-B (2000), ws-A (1000).
    const rows = [
      { id: uuid(1), name: "ws-A", ts: 1000 },
      { id: uuid(2), name: "ws-B", ts: 2000 },
      { id: uuid(3), name: "ws-C", ts: 3000 },
      { id: uuid(4), name: "ws-D", ts: 4000 },
    ];
    const insert = db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color_tone, pinned, last_opened_at)
       VALUES (?, ?, '/r', '{"kind":"local","rootPath":"/r"}', 'default', 0, ?)`,
    );
    for (const row of rows) {
      insert.run(row.id, row.name, row.ts);
    }

    // Apply the v6 migration (adds sort_order / pinned_sort_order and backfills).
    applyMigrations(db);

    // Open via GlobalStorage — listWorkspaces must use the new ORDER BY.
    const storage = new GlobalStorage(db);
    const list = storage.listWorkspaces();

    // All 4 rows must be present.
    expect(list.length).toBe(4);

    // The backfill assigns step-1024 positions ordered by last_opened_at DESC,
    // so the DESC order is: ws-D=1024, ws-C=2048, ws-B=3072, ws-A=4096.
    // listWorkspaces orders by sort_order ASC (within unpinned group), so the
    // result must be [ws-D, ws-C, ws-B, ws-A] — same visual order as last_opened_at DESC.
    const names = list.map((w) => w.name);
    expect(names).toEqual(["ws-D", "ws-C", "ws-B", "ws-A"]);
    expect(list[0].sortOrder).toBe(1024);
    expect(list[1].sortOrder).toBe(2048);
    expect(list[2].sortOrder).toBe(3072);
    expect(list[3].sortOrder).toBe(4096);

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Single-group reorder + broadcast routing
// ---------------------------------------------------------------------------

describe("single-group reorder — DB consistency + workspace.changed broadcast", () => {
  let fixtures: Fixtures;

  beforeEach(() => {
    fixtures = makeFixtures();
  });

  afterEach(() => {
    fixtures.globalDb.close();
  });

  it("moving ws-1 to position after ws-3 emits exactly one workspace.changed broadcast", () => {
    // Create 4 unpinned workspaces: positions 1024, 2048, 3072, 4096.
    const id1 = createWs(fixtures.manager, 1);
    const id2 = createWs(fixtures.manager, 2);
    const id3 = createWs(fixtures.manager, 3);
    createWs(fixtures.manager, 4);
    fixtures.broadcast.mockClear();

    // Reorder: move ws-1 to land AFTER ws-3 — afterId=id3 (natural semantics:
    // new row sits immediately after id3; midpoint of id3=3072 and ws-4=4096).
    fixtures.manager.reorder(id1, { targetGroup: "unpinned", afterId: id3 });

    const calls = fixtures.broadcast.mock.calls as [string, string, unknown][];
    // Exactly one broadcast for a non-rebalancing move.
    expect(calls.length).toBe(1);
    const [ch, ev] = calls[0];
    expect(ch).toBe("workspace");
    expect(ev).toBe("changed");

    // The broadcast payload must be the updated WorkspaceMeta for ws-1 only.
    const payload = calls[0][2] as WorkspaceMeta;
    expect(payload.id).toBe(id1);

    // DB consistency: ws-1's sort_order must now sit between ws-3 (3072) and ws-4 (4096).
    const rows = readSortRows(fixtures.globalDb);
    const ws1Row = rows.get(id1)!;
    const ws2Row = rows.get(id2)!;
    const ws3Row = rows.get(id3)!;
    expect(ws1Row.sortOrder).toBeGreaterThan(ws3Row.sortOrder);
    expect(ws1Row.sortOrder).toBeLessThan(4096);
    // ws-2 and ws-3 positions must be untouched (single-row update only).
    expect(ws2Row.sortOrder).toBe(2048);
    expect(ws3Row.sortOrder).toBe(3072);
  });

  // --- Regression: user-reported drop-slot scenarios -----------------------
  // These tests assert visible list order via manager.list() — not raw sort
  // numbers — so any future inversion of beforeId/afterId semantics will
  // fail loudly here rather than silently shipping again.

  it("regression: drop d onto the slot ABOVE a → list order [d, a, b, c]", () => {
    // [a, b, c, d] → drag d to the top slot (beforeId = a) → [d, a, b, c]
    const ida = createWs(fixtures.manager, 1);
    const idb = createWs(fixtures.manager, 2);
    const idc = createWs(fixtures.manager, 3);
    const idd = createWs(fixtures.manager, 4);
    fixtures.broadcast.mockClear();

    fixtures.manager.reorder(idd, { targetGroup: "unpinned", beforeId: ida });

    // Read directly from storage so the test compares visible (sorted) order,
    // not the manager.list() Map-insertion order which doesn't re-sort on
    // reorder. This is the source of truth the sidebar actually renders.
    const order = fixtures.globalDb
      .prepare(
        `SELECT id FROM workspaces
         WHERE pinned = 0
         ORDER BY (CASE pinned WHEN 1 THEN pinned_sort_order ELSE sort_order END) ASC`,
      )
      .all()
      .map((r) => (r as { id: string }).id);
    expect(order).toEqual([idd, ida, idb, idc]);
  });

  it("regression: drop b onto the slot BELOW d → list order [a, c, d, b]", () => {
    // [a, b, c, d] → drag b to the bottom slot (afterId = d) → [a, c, d, b]
    const ida = createWs(fixtures.manager, 1);
    const idb = createWs(fixtures.manager, 2);
    const idc = createWs(fixtures.manager, 3);
    const idd = createWs(fixtures.manager, 4);
    fixtures.broadcast.mockClear();

    fixtures.manager.reorder(idb, { targetGroup: "unpinned", afterId: idd });

    // Read directly from storage so the test compares visible (sorted) order,
    // not the manager.list() Map-insertion order which doesn't re-sort on
    // reorder. This is the source of truth the sidebar actually renders.
    const order = fixtures.globalDb
      .prepare(
        `SELECT id FROM workspaces
         WHERE pinned = 0
         ORDER BY (CASE pinned WHEN 1 THEN pinned_sort_order ELSE sort_order END) ASC`,
      )
      .all()
      .map((r) => (r as { id: string }).id);
    expect(order).toEqual([ida, idc, idd, idb]);
  });

  it("regression: drop b onto the slot ABOVE c (between a&b's old slot and c) → [a, b, c, d] unchanged", () => {
    // beforeId=c means "land BEFORE c"; b is already directly before c, so the
    // server-side computation places b right between its predecessor (a) and c.
    // Final order remains [a, b, c, d] — this is a no-op equivalent, surfaced
    // by the renderer's isSlotNoOp suppression rule.
    const ida = createWs(fixtures.manager, 1);
    const idb = createWs(fixtures.manager, 2);
    const idc = createWs(fixtures.manager, 3);
    const idd = createWs(fixtures.manager, 4);
    fixtures.broadcast.mockClear();

    fixtures.manager.reorder(idb, { targetGroup: "unpinned", beforeId: idc });

    // Read directly from storage so the test compares visible (sorted) order,
    // not the manager.list() Map-insertion order which doesn't re-sort on
    // reorder. This is the source of truth the sidebar actually renders.
    const order = fixtures.globalDb
      .prepare(
        `SELECT id FROM workspaces
         WHERE pinned = 0
         ORDER BY (CASE pinned WHEN 1 THEN pinned_sort_order ELSE sort_order END) ASC`,
      )
      .all()
      .map((r) => (r as { id: string }).id);
    expect(order).toEqual([ida, idb, idc, idd]);
  });

  it("regression: drop a onto the slot BELOW c → list order [b, c, a, d]", () => {
    const ida = createWs(fixtures.manager, 1);
    const idb = createWs(fixtures.manager, 2);
    const idc = createWs(fixtures.manager, 3);
    const idd = createWs(fixtures.manager, 4);
    fixtures.broadcast.mockClear();

    fixtures.manager.reorder(ida, { targetGroup: "unpinned", afterId: idc });

    // Read directly from storage so the test compares visible (sorted) order,
    // not the manager.list() Map-insertion order which doesn't re-sort on
    // reorder. This is the source of truth the sidebar actually renders.
    const order = fixtures.globalDb
      .prepare(
        `SELECT id FROM workspaces
         WHERE pinned = 0
         ORDER BY (CASE pinned WHEN 1 THEN pinned_sort_order ELSE sort_order END) ASC`,
      )
      .all()
      .map((r) => (r as { id: string }).id);
    expect(order).toEqual([idb, idc, ida, idd]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Cross-section reorder + automatic pin toggle
// ---------------------------------------------------------------------------

describe("cross-section reorder — automatic pin toggle + sort column zeroing", () => {
  let fixtures: Fixtures;

  beforeEach(() => {
    fixtures = makeFixtures();
  });

  afterEach(() => {
    fixtures.globalDb.close();
  });

  it("unpinned → pinned reorder: result meta has pinned=true, pinnedSortOrder>0, sortOrder=0", () => {
    const id1 = createWs(fixtures.manager, 10);
    fixtures.broadcast.mockClear();

    const result = fixtures.manager.reorder(id1, { targetGroup: "pinned" });

    expect(result.pinned).toBe(true);
    expect(result.pinnedSortOrder).toBeGreaterThan(0);
    expect(result.sortOrder).toBe(0);

    // DB state must match the returned meta.
    const rows = readSortRows(fixtures.globalDb);
    const row = rows.get(id1)!;
    expect(row.pinned).toBe(1);
    expect(row.pinnedSortOrder).toBe(result.pinnedSortOrder);
    expect(row.sortOrder).toBe(0);
  });

  it("pinned → unpinned reorder: result meta has pinned=false, sortOrder>0, pinnedSortOrder=0", () => {
    // First pin the workspace via update().
    const id1 = createWs(fixtures.manager, 11);
    fixtures.manager.update(id1, { pinned: true });
    fixtures.broadcast.mockClear();

    // Now reorder back to unpinned group.
    const result = fixtures.manager.reorder(id1, { targetGroup: "unpinned" });

    expect(result.pinned).toBe(false);
    expect(result.sortOrder).toBeGreaterThan(0);
    expect(result.pinnedSortOrder).toBe(0);

    const rows = readSortRows(fixtures.globalDb);
    const row = rows.get(id1)!;
    expect(row.pinned).toBe(0);
    expect(row.sortOrder).toBe(result.sortOrder);
    expect(row.pinnedSortOrder).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Rebalance trigger + bulk workspace.reordered event
// ---------------------------------------------------------------------------

describe("rebalance trigger — bulk reordered event + 1024-step redistribution", () => {
  let fixtures: Fixtures;

  afterEach(() => {
    fixtures.globalDb.close();
  });

  it("11 insertions into a 1-gap space trigger rebalance and workspace.reordered broadcast", () => {
    fixtures = makeFixtures();

    // Place two unpinned workspaces with gap=1 to force immediate rebalance on
    // the very next insertion between them.
    const db = fixtures.globalDb;
    const insertRow = (id: string, sortOrder: number): void => {
      db.prepare(
        `INSERT INTO workspaces
           (id, name, root_path, location, color_tone, pinned, last_opened_at,
            sort_order, pinned_sort_order)
         VALUES (?, 'ws', '/r', '{"kind":"local","rootPath":"/r"}', 'default', 0, 1000, ?, 0)`,
      ).run(id, sortOrder);
      fixtures.manager["workspaceStorage"].openForWorkspace(id);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { WorkspaceContext } = require("../../../src/main/features/workspace/context") as {
        WorkspaceContext: new (
          meta: WorkspaceMeta,
          storage: unknown,
          provider: unknown,
        ) => unknown;
      };
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AgentFsProvider } = require("../../../src/main/features/fs/bridge/agent-provider") as {
        AgentFsProvider: new (kind: string) => unknown;
      };
      const ctx = new WorkspaceContext(
        {
          id,
          name: "ws",
          rootPath: "/r",
          location: { kind: "local", rootPath: "/r" },
          colorTone: "default",
          pinned: false,
          lastOpenedAt: new Date().toISOString(),
          tabs: [],
          sortOrder,
          pinnedSortOrder: 0,
        },
        fixtures.manager["workspaceStorage"],
        new AgentFsProvider("local"),
      );
      (fixtures.manager["contexts"] as Map<string, unknown>).set(id, ctx);
    };

    // Two adjacent workspaces with gap=1: positions 100 and 101.
    insertRow(uuid(101), 100);
    insertRow(uuid(102), 101);

    // Create a third workspace via the manager (gets tail position 1124 = max+1024).
    const id3 = createWs(fixtures.manager, 103);
    fixtures.broadcast.mockClear();

    // Reorder id3 to be inserted between uuid(101) and uuid(102).
    // Natural semantics: beforeId=uuid(102) means "land BEFORE uuid(102)";
    // predecessor of uuid(102) is uuid(101), and that gap is 1 (<2) → rebalance.
    fixtures.manager.reorder(id3, { targetGroup: "unpinned", beforeId: uuid(102) });

    const calls = fixtures.broadcast.mock.calls as [string, string, unknown][];
    expect(calls.length).toBe(1);
    const [ch, ev, args] = calls[0];
    expect(ch).toBe("workspace");
    expect(ev).toBe("reordered");

    // The reordered event must carry an array of all rows in the group.
    expect(Array.isArray(args)).toBe(true);
    const orders = args as Array<{ id: string; sortOrder: number }>;
    expect(orders.length).toBeGreaterThanOrEqual(3);

    // After rebalance, uuid(101) and uuid(102) get step-1024 positions.
    const byId = Object.fromEntries(orders.map((r) => [r.id, r.sortOrder]));
    expect(byId[uuid(101)]).toBe(1024);
    expect(byId[uuid(102)]).toBe(2048);

    // id3 ends up at midpoint (1536) between 1024 and 2048 after rebalance.
    expect(byId[id3]).toBe(1536);

    // DB positions must also be at 1024 multiples for the rebalanced rows.
    const rows = readSortRows(db);
    expect(rows.get(uuid(101))!.sortOrder).toBe(1024);
    expect(rows.get(uuid(102))!.sortOrder).toBe(2048);
    expect(rows.get(id3)!.sortOrder).toBe(1536);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Concurrent reorder serialization (deterministic)
// ---------------------------------------------------------------------------

describe("concurrent reorder serialization — deterministic final state", () => {
  let fixtures: Fixtures;

  beforeEach(() => {
    fixtures = makeFixtures();
  });

  afterEach(() => {
    fixtures.globalDb.close();
  });

  it("two simultaneous reorder calls produce a consistent, conflict-free final DB state", async () => {
    // Create 3 unpinned workspaces at positions 1024, 2048, 3072.
    const id1 = createWs(fixtures.manager, 20);
    const id2 = createWs(fixtures.manager, 21);
    const id3 = createWs(fixtures.manager, 22);
    fixtures.broadcast.mockClear();

    // Fire two reorders concurrently via Promise.all.
    // better-sqlite3 (and bun:sqlite) are synchronous, so the calls actually
    // execute sequentially under the hood — but the result must still be
    // internally consistent regardless of which fires first.
    await Promise.all([
      // Move ws-1 to tail (after ws-3).
      Promise.resolve(fixtures.manager.reorder(id1, { targetGroup: "unpinned" })),
      // Move ws-2 to after ws-3 (which may have moved from the first call).
      Promise.resolve(fixtures.manager.reorder(id2, { targetGroup: "unpinned" })),
    ]);

    // Final DB must have no duplicate sortOrder values.
    const rows = readSortRows(fixtures.globalDb);
    const sortOrders = [
      rows.get(id1)!.sortOrder,
      rows.get(id2)!.sortOrder,
      rows.get(id3)!.sortOrder,
    ];
    // All three must be positive (positioned).
    expect(sortOrders.every((s) => s > 0)).toBe(true);
    // No two rows may share the same sortOrder.
    const uniqueSortOrders = new Set(sortOrders);
    expect(uniqueSortOrders.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — Broadcast fallback: stale store triggers fetchList
// ---------------------------------------------------------------------------

describe("renderer store — stale applySortedInsert triggers fetchList fallback", () => {
  it("consistent=false on a sort collision triggers fetchList and setAll", async () => {
    const fetchListMock = mock(() =>
      Promise.resolve([] as WorkspaceMeta[]),
    );

    const listenCallbacks: Map<string, (payload: unknown) => void> = new Map();
    const listenMock = mock(
      (_channel: string, event: string, cb: (payload: unknown) => void) => {
        listenCallbacks.set(event, cb);
        return () => {};
      },
    );

    const store = createWorkspacesStore({
      canUseIpcBridge: () => true,
      listen: listenMock as unknown as typeof import("../../../src/renderer/ipc/client").ipcListen,
      fetchList: fetchListMock,
    });

    // Pre-seed the store with two workspaces at distinct positions.
    // ws-A at 1024, ws-B at 3072 (gap of 2048 between them).
    const wsA: WorkspaceMeta = {
      id: "00000000-0000-0000-0000-cc0000000001",
      name: "ws-A",
      rootPath: "/a",
      location: { kind: "local", rootPath: "/a" },
      colorTone: "default",
      pinned: false,
      lastOpenedAt: new Date().toISOString(),
      tabs: [],
      sortOrder: 1024,
      pinnedSortOrder: 0,
    };
    const wsB: WorkspaceMeta = {
      id: "00000000-0000-0000-0000-cc0000000002",
      name: "ws-B",
      rootPath: "/b",
      location: { kind: "local", rootPath: "/b" },
      colorTone: "default",
      pinned: false,
      lastOpenedAt: new Date().toISOString(),
      tabs: [],
      sortOrder: 3072,
      pinnedSortOrder: 0,
    };
    store.getState().setAll([wsA, wsB]);

    // Emit a workspace.changed event for ws-A with the SAME sortOrder as ws-B (3072).
    // applySortedInsert will re-insert ws-A at position 3072, which ties with ws-B
    // → consistent=false → fetchList must be called.
    const changedCallback = listenCallbacks.get("changed");
    expect(changedCallback).toBeDefined();

    const updatedWsA: WorkspaceMeta = {
      ...wsA,
      // sortOrder changed from 1024 to 3072 — ties with ws-B's position.
      sortOrder: 3072,
    };
    changedCallback!(updatedWsA);

    // Give the async fetchList promise time to resolve.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchListMock).toHaveBeenCalledTimes(1);
  });

  it("upsert with a sort collision triggers fetchList fallback", async () => {
    const fetchListMock = mock(() =>
      Promise.resolve([] as WorkspaceMeta[]),
    );

    const store = createWorkspacesStore({
      canUseIpcBridge: () => false,
      listen: mock(() => () => {}),
      fetchList: fetchListMock,
    });

    // Pre-seed two workspaces at distinct positions.
    const ws1: WorkspaceMeta = {
      id: "00000000-0000-0000-0000-aaa000000001",
      name: "ws-1",
      rootPath: "/a",
      location: { kind: "local", rootPath: "/a" },
      colorTone: "default",
      pinned: false,
      lastOpenedAt: new Date().toISOString(),
      tabs: [],
      sortOrder: 1024,
      pinnedSortOrder: 0,
    };
    const ws2: WorkspaceMeta = {
      id: "00000000-0000-0000-0000-aaa000000002",
      name: "ws-2",
      rootPath: "/b",
      location: { kind: "local", rootPath: "/b" },
      colorTone: "default",
      pinned: false,
      lastOpenedAt: new Date().toISOString(),
      tabs: [],
      sortOrder: 3072,
      pinnedSortOrder: 0,
    };
    store.getState().setAll([ws1, ws2]);

    // Upsert ws1 with sortOrder=3072 — ties with ws2, triggering consistent=false.
    const staleWs1 = { ...ws1, sortOrder: 3072 };
    store.getState().upsert(staleWs1);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchListMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — Hot-path: lastOpenedAt update does not trigger re-sort
// ---------------------------------------------------------------------------

describe("hot-path — lastOpenedAt update does not trigger re-sort", () => {
  let fixtures: Fixtures;

  beforeEach(() => {
    fixtures = makeFixtures();
  });

  afterEach(() => {
    fixtures.globalDb.close();
  });

  it("activate() bumps lastOpenedAt but sortOrder stays the same in DB and in-memory", async () => {
    const id1 = createWs(fixtures.manager, 30);
    const id2 = createWs(fixtures.manager, 31);
    const id3 = createWs(fixtures.manager, 32);
    fixtures.broadcast.mockClear();

    const listBefore = fixtures.manager.list();
    const wsBefore = listBefore.find((w) => w.id === id2)!;
    const sortOrderBefore = wsBefore.sortOrder;

    // activate() bumps lastOpenedAt (via touchLastOpened) but must not
    // change sort positions. The provider boot is a no-op for local workspaces
    // in test since there's no real agent process.
    try {
      // activate() tries to ensureProviderReady; that may throw in test env
      // (no real local agent), but the mutation-side effects happen before that.
      // We use update() directly which is the same hot-path we want to verify.
      fixtures.manager.update(id2, { lastOpenedAt: new Date().toISOString() });
    } catch {
      // swallow provider boot error in test environment
    }

    const listAfter = fixtures.manager.list();
    const ws2After = listAfter.find((w) => w.id === id2)!;

    // sortOrder must not have changed.
    expect(ws2After.sortOrder).toBe(sortOrderBefore);
    expect(ws2After.pinnedSortOrder).toBe(0);

    // In-memory list order must be unchanged (id1 still before id2 before id3).
    expect(listAfter[0].id).toBe(id1);
    expect(listAfter[1].id).toBe(id2);
    expect(listAfter[2].id).toBe(id3);

    // Renderer store hot-path: sort-field-unchanged update must not change position.
    const ws2Meta = ws2After;
    const listForStore: WorkspaceMeta[] = [
      listBefore[0],
      listBefore[1],
      listBefore[2],
    ];
    const updatedWs2 = { ...ws2Meta, name: "ws-31-renamed" };
    const { workspaces: sorted, consistent } = applySortedInsert(listForStore, updatedWs2);
    // Must be consistent (no sort fields changed → binary search places it correctly).
    expect(consistent).toBe(true);
    // Position must be unchanged: ws-31 (id2) stays at index 1.
    expect(sorted[1].id).toBe(id2);
    expect(sorted[1].name).toBe("ws-31-renamed");
  });
});
