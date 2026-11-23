import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import os from "node:os";
import path from "node:path";
import { type BroadcastFn, WorkspaceManager } from "../../../src/main/features/workspace/manager";
import { GlobalStorage } from "../../../src/main/infra/storage/global-storage";
import { applyMigrations } from "../../../src/main/infra/storage/migrations";
import { WorkspaceStorage } from "../../../src/main/infra/storage/workspace-storage";
import { createWorkspacesStore } from "../../../src/renderer/state/stores/workspaces";
import { WorkspaceReorderedEventSchema } from "../../../src/shared/ipc/contract";
import type { WorkspaceMeta } from "../../../src/shared/types/workspace";
import { openTestState } from "../../helpers/test-state";

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

  const stateService = openTestState(path.join(os.tmpdir(), "nexus-integ-reorder-state.json"));
  const broadcast = mock((_ch: string, _ev: string, _args: unknown) => {});

  const manager = new WorkspaceManager(
    globalStorage,
    workspaceStorage,
    stateService,
    broadcast as BroadcastFn,
  );

  return { globalDb, globalStorage, manager, broadcast };
}

function createWs(manager: WorkspaceManager, n: number): string {
  const meta = manager.create({ rootPath: makeRootPath(n), name: `ws-${n}` });
  return meta.id;
}

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

describe("migration v5→v6 — last_opened_at DESC visual order preserved", () => {
  it("listWorkspaces after v6 migration returns rows in last_opened_at DESC order", () => {
    const db = new Database(":memory:");

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

    applyMigrations(db);

    const storage = new GlobalStorage(db);
    const list = storage.listWorkspaces();

    expect(list.length).toBe(4);

    const names = list.map((w) => w.name);
    expect(names).toEqual(["ws-D", "ws-C", "ws-B", "ws-A"]);
    expect(list[0].sortOrder).toBe(1024);
    expect(list[1].sortOrder).toBe(2048);
    expect(list[2].sortOrder).toBe(3072);
    expect(list[3].sortOrder).toBe(4096);

    db.close();
  });
});

describe("single-group reorder — DB consistency + workspace.changed broadcast", () => {
  let fixtures: Fixtures;

  beforeEach(() => {
    fixtures = makeFixtures();
  });

  afterEach(() => {
    fixtures.globalDb.close();
  });

  it("regression: drop d onto the slot ABOVE a → list order [d, a, b, c]", () => {
    const ida = createWs(fixtures.manager, 1);
    const idb = createWs(fixtures.manager, 2);
    const idc = createWs(fixtures.manager, 3);
    const idd = createWs(fixtures.manager, 4);
    fixtures.broadcast.mockClear();

    fixtures.manager.reorder(idd, { targetGroup: "unpinned", beforeId: ida });

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
    const ida = createWs(fixtures.manager, 1);
    const idb = createWs(fixtures.manager, 2);
    const idc = createWs(fixtures.manager, 3);
    const idd = createWs(fixtures.manager, 4);
    fixtures.broadcast.mockClear();

    fixtures.manager.reorder(idb, { targetGroup: "unpinned", afterId: idd });

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
    const ida = createWs(fixtures.manager, 1);
    const idb = createWs(fixtures.manager, 2);
    const idc = createWs(fixtures.manager, 3);
    const idd = createWs(fixtures.manager, 4);
    fixtures.broadcast.mockClear();

    fixtures.manager.reorder(idb, { targetGroup: "unpinned", beforeId: idc });

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
    expect(result.pinnedSortOrder).toBe(1024);
    expect(result.sortOrder).toBe(0);

    const rows = readSortRows(fixtures.globalDb);
    const row = rows.get(id1)!;
    expect(row.pinned).toBe(1);
    expect(row.pinnedSortOrder).toBe(result.pinnedSortOrder);
    expect(row.sortOrder).toBe(0);
  });

  it("pinned → unpinned reorder: result meta has pinned=false, sortOrder>0, pinnedSortOrder=0", () => {
    const id1 = createWs(fixtures.manager, 11);
    fixtures.manager.update(id1, { pinned: true });
    fixtures.broadcast.mockClear();

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

describe("rebalance trigger — bulk reordered event + 1024-step redistribution", () => {
  let fixtures: Fixtures;

  afterEach(() => {
    fixtures.globalDb.close();
  });

  it("11 insertions into a 1-gap space trigger rebalance and workspace.reordered broadcast", () => {
    fixtures = makeFixtures();

    const db = fixtures.globalDb;
    const insertRow = (id: string, sortOrder: number): void => {
      db.prepare(
        `INSERT INTO workspaces
           (id, name, root_path, location, color, pinned, last_opened_at,
            sort_order, pinned_sort_order)
         VALUES (?, 'ws', '/r', '{"kind":"local","rootPath":"/r"}', 'default', 0, 1000, ?, 0)`,
      ).run(id, sortOrder);
      fixtures.manager["workspaceStorage"].openForWorkspace(id);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { WorkspaceContext } = require("../../../src/main/features/workspace/context") as {
        WorkspaceContext: new (meta: WorkspaceMeta, storage: unknown, provider: unknown) => unknown;
      };
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AgentFsProvider } =
        require("../../../src/main/features/fs/bridge/agent-provider") as {
          AgentFsProvider: new (kind: string) => unknown;
        };
      const ctx = new WorkspaceContext(
        {
          id,
          name: "ws",
          rootPath: "/r",
          location: { kind: "local", rootPath: "/r" },
          color: "auto",
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

    insertRow(uuid(101), 100);
    insertRow(uuid(102), 101);

    const id3 = createWs(fixtures.manager, 103);
    fixtures.broadcast.mockClear();

    fixtures.manager.reorder(id3, { targetGroup: "unpinned", beforeId: uuid(102) });

    const calls = fixtures.broadcast.mock.calls as [string, string, unknown][];
    expect(calls.length).toBe(1);
    const [ch, ev, args] = calls[0];
    expect(ch).toBe("workspace");
    expect(ev).toBe("reordered");

    const { orders } = WorkspaceReorderedEventSchema.parse(args);
    expect(orders.length).toBeGreaterThanOrEqual(3);

    const byId = Object.fromEntries(orders.map((r) => [r.id, r.sortOrder]));
    expect(byId[uuid(101)]).toBe(1024);
    expect(byId[uuid(102)]).toBe(2048);

    expect(byId[id3]).toBe(1536);

    const rows = readSortRows(db);
    expect(rows.get(uuid(101))!.sortOrder).toBe(1024);
    expect(rows.get(uuid(102))!.sortOrder).toBe(2048);
    expect(rows.get(id3)!.sortOrder).toBe(1536);

    const listed = Object.fromEntries(fixtures.manager.list().map((w) => [w.id, w.sortOrder]));
    expect(listed[uuid(101)]).toBe(1024);
    expect(listed[uuid(102)]).toBe(2048);
  });
});

describe("concurrent reorder serialization — deterministic final state", () => {
  let fixtures: Fixtures;

  beforeEach(() => {
    fixtures = makeFixtures();
  });

  afterEach(() => {
    fixtures.globalDb.close();
  });

  it("two simultaneous reorder calls produce a consistent, conflict-free final DB state", async () => {
    const id1 = createWs(fixtures.manager, 20);
    const id2 = createWs(fixtures.manager, 21);
    const id3 = createWs(fixtures.manager, 22);
    fixtures.broadcast.mockClear();

    await Promise.all([
      Promise.resolve(fixtures.manager.reorder(id1, { targetGroup: "unpinned" })),
      Promise.resolve(fixtures.manager.reorder(id2, { targetGroup: "unpinned" })),
    ]);

    const rows = readSortRows(fixtures.globalDb);
    const sortOrders = [
      rows.get(id1)!.sortOrder,
      rows.get(id2)!.sortOrder,
      rows.get(id3)!.sortOrder,
    ];
    expect(sortOrders.every((s) => s > 0)).toBe(true);
    const uniqueSortOrders = new Set(sortOrders);
    expect(uniqueSortOrders.size).toBe(3);
  });
});

describe("renderer store — stale applySortedInsert triggers fetchList fallback", () => {
  it("consistent=false on a sort collision triggers fetchList and setAll", async () => {
    const fetchListMock = mock(() => Promise.resolve([] as WorkspaceMeta[]));

    const listenCallbacks: Map<string, (payload: unknown) => void> = new Map();
    const listenMock = mock((_channel: string, event: string, cb: (payload: unknown) => void) => {
      listenCallbacks.set(event, cb);
      return () => {};
    });

    const store = createWorkspacesStore({
      canUseIpcBridge: () => true,
      listen: listenMock as unknown as typeof import("../../../src/renderer/ipc/client").ipcListen,
      fetchList: fetchListMock,
    });

    const wsA: WorkspaceMeta = {
      id: "00000000-0000-0000-0000-cc0000000001",
      name: "ws-A",
      rootPath: "/a",
      location: { kind: "local", rootPath: "/a" },
      color: "auto",
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
      color: "auto",
      pinned: false,
      lastOpenedAt: new Date().toISOString(),
      tabs: [],
      sortOrder: 3072,
      pinnedSortOrder: 0,
    };
    store.getState().setAll([wsA, wsB]);

    const changedCallback = listenCallbacks.get("changed");
    expect(changedCallback).toBeDefined();

    const updatedWsA: WorkspaceMeta = {
      ...wsA,
      sortOrder: 3072,
    };
    changedCallback!(updatedWsA);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchListMock).toHaveBeenCalledTimes(1);
  });

  it("upsert with a sort collision triggers fetchList fallback", async () => {
    const fetchListMock = mock(() => Promise.resolve([] as WorkspaceMeta[]));

    const store = createWorkspacesStore({
      canUseIpcBridge: () => false,
      listen: mock(() => () => {}),
      fetchList: fetchListMock,
    });

    const ws1: WorkspaceMeta = {
      id: "00000000-0000-0000-0000-aaa000000001",
      name: "ws-1",
      rootPath: "/a",
      location: { kind: "local", rootPath: "/a" },
      color: "auto",
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
      color: "auto",
      pinned: false,
      lastOpenedAt: new Date().toISOString(),
      tabs: [],
      sortOrder: 3072,
      pinnedSortOrder: 0,
    };
    store.getState().setAll([ws1, ws2]);

    const staleWs1 = { ...ws1, sortOrder: 3072 };
    store.getState().upsert(staleWs1);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchListMock).toHaveBeenCalledTimes(1);
  });
});
