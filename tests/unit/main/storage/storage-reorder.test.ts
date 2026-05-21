/**
 * Unit tests for workspace reorder, create with tail position, and pin-toggle
 * sort-order management.
 *
 * Uses bun:sqlite in-memory databases so every test starts from a clean state
 * without touching the filesystem.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import os from "node:os";
import path from "node:path";
import { GlobalStorage } from "../../../../src/main/infra/storage/global-storage";
import { StateService } from "../../../../src/main/infra/storage/state-service";
import { WorkspaceStorage } from "../../../../src/main/infra/storage/workspace-storage";
import { type BroadcastFn, WorkspaceManager } from "../../../../src/main/features/workspace/manager";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

function makeRootPath(n: number): string {
  return path.join(os.tmpdir(), `ws-reorder-${n}`);
}

/**
 * Builds the full test fixture: in-memory GlobalStorage + temp WorkspaceStorage
 * + a mock broadcast function.  WorkspaceStorage uses an in-memory DB per
 * workspace so no real filesystem state is needed.
 */
function makeFixtures(): {
  globalDb: Database;
  globalStorage: GlobalStorage;
  manager: WorkspaceManager;
  broadcast: ReturnType<typeof mock>;
} {
  const globalDb = new Database(":memory:");
  const globalStorage = new GlobalStorage(globalDb);

  // WorkspaceStorage needs a base directory; we use os.tmpdir() but the
  // actual per-workspace DB files are created in bun:sqlite memory mode via
  // the injected factory.
  const wsBaseDir = path.join(os.tmpdir(), "nexus-reorder-test");
  const workspaceStorage = new WorkspaceStorage(wsBaseDir, () => new Database(":memory:"));

  const stateService = new StateService(path.join(os.tmpdir(), "nexus-reorder-state.json"));
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
 * Creates a workspace via manager.create() and returns its id.
 */
function createWs(manager: WorkspaceManager, n: number): string {
  const meta = manager.create({ rootPath: makeRootPath(n), name: `ws-${n}` });
  return meta.id;
}

// ---------------------------------------------------------------------------
// create() places new workspace at the tail of the unpinned group
// ---------------------------------------------------------------------------

describe("WorkspaceManager.create — sort position", () => {
  let fixtures: ReturnType<typeof makeFixtures>;

  beforeEach(() => {
    fixtures = makeFixtures();
  });

  afterEach(() => {
    fixtures.globalDb.close();
  });

  it("first workspace gets sortOrder=1024, pinnedSortOrder=0", () => {
    const meta = fixtures.manager.create({ rootPath: makeRootPath(1), name: "ws-1" });
    expect(meta.sortOrder).toBe(1024);
    expect(meta.pinnedSortOrder).toBe(0);
    expect(meta.pinned).toBe(false);
  });

  it("second workspace gets sortOrder=2048 (tail after first)", () => {
    fixtures.manager.create({ rootPath: makeRootPath(1), name: "ws-1" });
    const meta = fixtures.manager.create({ rootPath: makeRootPath(2), name: "ws-2" });
    expect(meta.sortOrder).toBe(2048);
  });

  it("create broadcast includes sortOrder and pinnedSortOrder", () => {
    const meta = fixtures.manager.create({ rootPath: makeRootPath(1), name: "ws-1" });
    const calls = fixtures.broadcast.mock.calls;
    const lastCall = calls[calls.length - 1] as [string, string, WorkspaceMeta];
    expect(lastCall[2].sortOrder).toBe(meta.sortOrder);
    expect(lastCall[2].pinnedSortOrder).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// update({pinned: true}) — pin toggle moves to tail of pinned group
// ---------------------------------------------------------------------------

describe("WorkspaceManager.update — pin toggle", () => {
  let fixtures: ReturnType<typeof makeFixtures>;
  let wsId: string;

  beforeEach(() => {
    fixtures = makeFixtures();
    wsId = createWs(fixtures.manager, 1);
    fixtures.broadcast.mockClear();
  });

  afterEach(() => {
    fixtures.globalDb.close();
  });

  it("toggling pinned=true sets pinnedSortOrder=1024 and sortOrder=0", () => {
    const updated = fixtures.manager.update(wsId, { pinned: true });
    expect(updated.pinned).toBe(true);
    expect(updated.pinnedSortOrder).toBe(1024);
    expect(updated.sortOrder).toBe(0);
  });

  it("toggling pinned=false moves to tail of unpinned group and zeros pinnedSortOrder", () => {
    // First pin it
    fixtures.manager.update(wsId, { pinned: true });
    fixtures.broadcast.mockClear();
    // Then unpin
    const updated = fixtures.manager.update(wsId, { pinned: false });
    expect(updated.pinned).toBe(false);
    expect(updated.sortOrder).toBe(1024);
    expect(updated.pinnedSortOrder).toBe(0);
  });

  it("second pinned workspace goes to tail (pinnedSortOrder=2048)", () => {
    const wsId2 = createWs(fixtures.manager, 2);
    fixtures.manager.update(wsId, { pinned: true });
    const updated2 = fixtures.manager.update(wsId2, { pinned: true });
    expect(updated2.pinnedSortOrder).toBe(2048);
  });

  it("changed broadcast carries updated sort fields after pin toggle", () => {
    fixtures.manager.update(wsId, { pinned: true });
    const calls = fixtures.broadcast.mock.calls;
    const lastCall = calls[calls.length - 1] as [string, string, WorkspaceMeta];
    expect(lastCall[0]).toBe("workspace");
    expect(lastCall[1]).toBe("changed");
    expect(lastCall[2].pinned).toBe(true);
    expect(lastCall[2].pinnedSortOrder).toBe(1024);
    expect(lastCall[2].sortOrder).toBe(0);
  });

  it("update without pinned change does not alter sort positions (hot path)", () => {
    const before = fixtures.manager.list().find((w) => w.id === wsId)!;
    fixtures.manager.update(wsId, { name: "renamed" });
    const after = fixtures.manager.list().find((w) => w.id === wsId)!;
    expect(after.sortOrder).toBe(before.sortOrder);
    expect(after.pinnedSortOrder).toBe(before.pinnedSortOrder);
  });
});

// ---------------------------------------------------------------------------
// reorder — same group (unpinned → unpinned)
// ---------------------------------------------------------------------------

describe("WorkspaceManager.reorder — same group", () => {
  let fixtures: ReturnType<typeof makeFixtures>;
  let id1: string;
  let id2: string;
  let id3: string;

  beforeEach(() => {
    fixtures = makeFixtures();
    // Create 3 workspaces: positions 1024, 2048, 3072
    id1 = createWs(fixtures.manager, 1);
    id2 = createWs(fixtures.manager, 2);
    id3 = createWs(fixtures.manager, 3);
    fixtures.broadcast.mockClear();
  });

  afterEach(() => {
    fixtures.globalDb.close();
  });

  it("reorder to tail (no reference) appends after last item", () => {
    const result = fixtures.manager.reorder(id1, { targetGroup: "unpinned" });
    // id1 was at 1024; tail is now max(2048,3072) + 1024 = 4096
    expect(result.sortOrder).toBe(4096);
    expect(result.pinned).toBe(false);
  });

  it("reorder with beforeId=id2 places id1 immediately before id2", () => {
    // Initial sort_orders: id1=1024, id2=2048, id3=3072.
    // beforeId=id2 means "land BEFORE id2"; predecessor of id2 (excluding id1's
    // own row is irrelevant because id1's pos shifts) is id1 at 1024.
    // Midpoint(1024, 2048) = floor(3072/2) = 1536.
    const result = fixtures.manager.reorder(id1, {
      targetGroup: "unpinned",
      beforeId: id2,
    });
    expect(result.sortOrder).toBe(1536);
    expect(result.pinnedSortOrder).toBe(0);
  });

  it("reorder with afterId=id2 places id1 immediately after id2", () => {
    // Initial sort_orders: id1=1024, id2=2048, id3=3072.
    // afterId=id2 means "land AFTER id2"; successor of id2 is id3 at 3072.
    // Midpoint(2048, 3072) = floor(5120/2) = 2560.
    const result = fixtures.manager.reorder(id1, {
      targetGroup: "unpinned",
      afterId: id2,
    });
    expect(result.sortOrder).toBe(2560);
    expect(result.pinnedSortOrder).toBe(0);
  });

  it("reorder does not change pinned flag when staying in unpinned group", () => {
    const result = fixtures.manager.reorder(id1, { targetGroup: "unpinned" });
    expect(result.pinned).toBe(false);
  });

  it("workspace.changed is broadcast (not reordered) for a normal single-item move", () => {
    fixtures.manager.reorder(id1, { targetGroup: "unpinned" });
    const calls = fixtures.broadcast.mock.calls;
    expect(calls.length).toBe(1);
    const [ch, ev] = calls[0] as [string, string, unknown];
    expect(ch).toBe("workspace");
    expect(ev).toBe("changed");
  });

  it("in-memory list() reflects new sort order after reorder", () => {
    // Move id1 to tail
    fixtures.manager.reorder(id1, { targetGroup: "unpinned" });
    const list = fixtures.manager.list();
    const ws1 = list.find((w) => w.id === id1)!;
    expect(ws1.sortOrder).toBe(4096);
  });
});

// ---------------------------------------------------------------------------
// reorder — cross group (unpinned → pinned)
// ---------------------------------------------------------------------------

describe("WorkspaceManager.reorder — cross group", () => {
  let fixtures: ReturnType<typeof makeFixtures>;
  let id1: string;
  let id2: string;

  beforeEach(() => {
    fixtures = makeFixtures();
    id1 = createWs(fixtures.manager, 1);
    id2 = createWs(fixtures.manager, 2);
    fixtures.broadcast.mockClear();
  });

  afterEach(() => {
    fixtures.globalDb.close();
  });

  it("moving from unpinned to pinned sets pinned=true and pinnedSortOrder, zeros sortOrder", () => {
    const result = fixtures.manager.reorder(id1, { targetGroup: "pinned" });
    expect(result.pinned).toBe(true);
    expect(result.pinnedSortOrder).toBe(1024); // tail of empty pinned group
    expect(result.sortOrder).toBe(0);
  });

  it("moving from pinned back to unpinned sets pinned=false and sortOrder, zeros pinnedSortOrder", () => {
    // First pin id1
    fixtures.manager.reorder(id1, { targetGroup: "pinned" });
    fixtures.broadcast.mockClear();
    // Then move it back
    const result = fixtures.manager.reorder(id1, { targetGroup: "unpinned" });
    expect(result.pinned).toBe(false);
    expect(result.pinnedSortOrder).toBe(0);
    expect(result.sortOrder).toBeGreaterThan(0);
  });

  it("second cross-group move appends at tail of pinned group", () => {
    fixtures.manager.reorder(id1, { targetGroup: "pinned" });
    const result = fixtures.manager.reorder(id2, { targetGroup: "pinned" });
    expect(result.pinnedSortOrder).toBe(2048);
  });
});

// ---------------------------------------------------------------------------
// reorder — rebalance trigger
// ---------------------------------------------------------------------------

describe("WorkspaceManager.reorder — rebalance", () => {
  let fixtures: ReturnType<typeof makeFixtures>;

  afterEach(() => {
    fixtures.globalDb.close();
  });

  it("workspace.reordered is broadcast when rebalance is triggered, with all affected rows", () => {
    fixtures = makeFixtures();

    // Manually insert rows with collapsed positions to force a rebalance.
    const db = fixtures.globalDb;
    const insertRow = (id: string, sortOrder: number) => {
      db.prepare(
        `INSERT INTO workspaces
           (id, name, root_path, location, color_tone, pinned, last_opened_at,
            sort_order, pinned_sort_order)
         VALUES (?, 'ws', '/r', '{"kind":"local","rootPath":"/r"}', 'default', 0, 1000, ?, 0)`,
      ).run(id, sortOrder);
      // Open the per-workspace storage handle so the context can be built.
      fixtures.manager["workspaceStorage"].openForWorkspace(id);
      const { WorkspaceContext } = require("../../../../src/main/features/workspace/context");
      const { AgentFsProvider } = require("../../../../src/main/features/fs/bridge/agent-provider");
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
      fixtures.manager["contexts"].set(id, ctx);
    };

    insertRow(uuid(1), 100);
    insertRow(uuid(2), 101); // gap = 1, will trigger rebalance when inserting between them

    fixtures.broadcast.mockClear();

    // Move a new third workspace between uuid(1) and uuid(2) — gap < 2 → rebalance.
    // Natural semantics: beforeId=uuid(2) means "land BEFORE uuid(2)";
    // predecessor of uuid(2) is uuid(1), and the gap there is 1 (< 2) → rebalance.
    const id3 = createWs(fixtures.manager, 3);
    fixtures.broadcast.mockClear();
    fixtures.manager.reorder(id3, { targetGroup: "unpinned", beforeId: uuid(2) });

    const calls = fixtures.broadcast.mock.calls;
    expect(calls.length).toBe(1);
    const [ch, ev, args] = calls[0] as [string, string, Array<{ id: string; sortOrder: number }>];
    expect(ch).toBe("workspace");
    expect(ev).toBe("reordered");
    // The reordered event must include all rows in the group.
    expect(Array.isArray(args)).toBe(true);
    expect(args.length).toBeGreaterThanOrEqual(2);

    // After rebalance, uuid(1) and uuid(2) are at step-1024 positions (1024, 2048).
    // The moved workspace (id3) is inserted between them at the midpoint (1536).
    const byId = Object.fromEntries(args.map((r) => [r.id, r.sortOrder]));
    expect(byId[uuid(1)]).toBe(1024);
    expect(byId[uuid(2)]).toBe(2048);
    // id3 ends up at midpoint between 1024 and 2048 after rebalance.
    expect(byId[id3]).toBe(1536);
  });
});
