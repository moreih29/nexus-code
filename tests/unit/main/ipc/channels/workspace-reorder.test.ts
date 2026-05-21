/**
 * Unit tests for the workspace.reorder IPC handler.
 *
 * Verifies that the handler:
 *   - delegates to manager.reorder with the arguments extracted from the
 *     validated args payload
 *   - returns the WorkspaceMeta produced by manager.reorder (the router wraps
 *     it in an ipcOk envelope — the handler itself stays simple)
 *   - the return value passes the ipcContract.workspace.call.reorder.result schema
 */

import { Database } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";
import os from "node:os";
import path from "node:path";
import { GlobalStorage } from "../../../../../src/main/infra/storage/global-storage";
import { StateService } from "../../../../../src/main/infra/storage/state-service";
import { WorkspaceStorage } from "../../../../../src/main/infra/storage/workspace-storage";
import {
  type BroadcastFn,
  WorkspaceManager,
} from "../../../../../src/main/features/workspace/manager";
import { ipcContract } from "../../../../../src/shared/ipc/contract";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(): { manager: WorkspaceManager; globalDb: Database } {
  const globalDb = new Database(":memory:");
  const globalStorage = new GlobalStorage(globalDb);
  const wsBaseDir = path.join(os.tmpdir(), "nexus-ipc-reorder-test");
  const workspaceStorage = new WorkspaceStorage(wsBaseDir, () => new Database(":memory:"));
  const stateService = new StateService(path.join(os.tmpdir(), "nexus-ipc-reorder-state.json"));
  const broadcast = mock((_ch: string, _ev: string, _args: unknown) => {}) as BroadcastFn;
  return {
    manager: new WorkspaceManager(globalStorage, workspaceStorage, stateService, broadcast),
    globalDb,
  };
}

/**
 * Builds the reorder handler closure that mirrors what registerWorkspaceChannel
 * registers, using the shared validateArgs + ipcContract reference.  This lets
 * tests invoke the exact same logic without spinning up Electron IPC.
 */
function makeReorderHandler(manager: WorkspaceManager) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { validateArgs } = require("../../../../../src/main/infra/ipc-router") as {
    validateArgs: <T>(schema: { parse: (v: unknown) => T }, args: unknown) => T;
  };
  const c = ipcContract.workspace.call;
  return (args: unknown) => {
    const { id, beforeId, afterId, targetGroup } = validateArgs(c.reorder.args, args);
    return manager.reorder(id, { beforeId, afterId, targetGroup });
  };
}

// ---------------------------------------------------------------------------
// Contract presence
// ---------------------------------------------------------------------------

describe("workspace.reorder contract entries", () => {
  it("reorder is present in ipcContract.workspace.call", () => {
    expect(ipcContract.workspace.call.reorder).toBeDefined();
    expect(ipcContract.workspace.call.reorder.args).toBeDefined();
    expect(ipcContract.workspace.call.reorder.result).toBeDefined();
  });

  it("reordered is present in ipcContract.workspace.listen", () => {
    expect(ipcContract.workspace.listen.reordered).toBeDefined();
    expect(ipcContract.workspace.listen.reordered.args).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Handler delegation
// ---------------------------------------------------------------------------

describe("workspace.reorder handler — manager.reorder delegation", () => {
  it("calls manager.reorder with id and options from the args payload", () => {
    const { manager, globalDb } = makeManager();
    const meta = manager.create({ rootPath: path.join(os.tmpdir(), "ws-ipc-1"), name: "ws-1" });
    const wsId = meta.id;

    // Capture calls without introducing recursion: bind the real method first,
    // then replace the instance method with a thin wrapper.
    const realReorder = manager.reorder.bind(manager);
    const calls: Array<[string, unknown]> = [];
    (manager as unknown as { reorder: unknown }).reorder = (id: string, opts: unknown) => {
      calls.push([id, opts]);
      return realReorder(id, opts as never);
    };

    const handler = makeReorderHandler(manager);
    const result = handler({ id: wsId, targetGroup: "unpinned" }) as { id: string };

    expect(calls.length).toBe(1);
    const [calledId, calledOpts] = calls[0] as [
      string,
      { beforeId?: string; afterId?: string; targetGroup: string },
    ];
    expect(calledId).toBe(wsId);
    expect(calledOpts.targetGroup).toBe("unpinned");
    expect(calledOpts.beforeId).toBeUndefined();
    expect(calledOpts.afterId).toBeUndefined();
    expect(result.id).toBe(wsId);

    globalDb.close();
  });

  it("forwards beforeId when provided", () => {
    const { manager, globalDb } = makeManager();
    const m1 = manager.create({ rootPath: path.join(os.tmpdir(), "ws-ipc-a"), name: "a" });
    const m2 = manager.create({ rootPath: path.join(os.tmpdir(), "ws-ipc-b"), name: "b" });

    const realReorder = manager.reorder.bind(manager);
    const calls: Array<[string, unknown]> = [];
    (manager as unknown as { reorder: unknown }).reorder = (id: string, opts: unknown) => {
      calls.push([id, opts]);
      return realReorder(id, opts as never);
    };

    const handler = makeReorderHandler(manager);
    handler({ id: m2.id, beforeId: m1.id, targetGroup: "unpinned" });

    const [, calledOpts] = calls[0] as [string, { beforeId?: string; targetGroup: string }];
    expect(calledOpts.beforeId).toBe(m1.id);
    expect(calledOpts.targetGroup).toBe("unpinned");

    globalDb.close();
  });
});

// ---------------------------------------------------------------------------
// Return value matches contract result schema
// ---------------------------------------------------------------------------

describe("workspace.reorder handler — ipcOk result", () => {
  it("handler return value passes ipcContract.workspace.call.reorder.result schema", () => {
    const { manager, globalDb } = makeManager();
    const meta = manager.create({ rootPath: path.join(os.tmpdir(), "ws-ipc-2"), name: "ws-2" });

    const handler = makeReorderHandler(manager);
    const returned = handler({ id: meta.id, targetGroup: "unpinned" });

    const parsed = ipcContract.workspace.call.reorder.result.safeParse(returned);
    if (!parsed.success) {
      throw new Error(`reorder result failed schema: ${parsed.error.toString()}`);
    }

    globalDb.close();
  });

  it("cross-group reorder result has pinned=true and assigned pinnedSortOrder", () => {
    const { manager, globalDb } = makeManager();
    const meta = manager.create({ rootPath: path.join(os.tmpdir(), "ws-ipc-3"), name: "ws-3" });

    const handler = makeReorderHandler(manager);
    const returned = handler({ id: meta.id, targetGroup: "pinned" }) as {
      pinned: boolean;
      pinnedSortOrder: number;
      sortOrder: number;
    };

    expect(returned.pinned).toBe(true);
    expect(returned.pinnedSortOrder).toBeGreaterThan(0);
    expect(returned.sortOrder).toBe(0);

    globalDb.close();
  });
});
