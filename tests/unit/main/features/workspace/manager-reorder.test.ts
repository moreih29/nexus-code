import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceManager } from "../../../../../src/main/features/workspace/manager";
import { GlobalStorage } from "../../../../../src/main/infra/storage/global-storage";
import { StateService } from "../../../../../src/main/infra/storage/state-service";
import { WorkspaceStorage } from "../../../../../src/main/infra/storage/workspace-storage";
import { WorkspaceReorderedEventSchema } from "../../../../../src/shared/ipc/contract";

test.each([
  false,
  true,
])("a rebalance includes the moved row in the IPC envelope (previously pinned %s)", (wasPinned) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-rebalance-"));
  const storage = new GlobalStorage(new Database(":memory:"));
  const broadcast = mock((_channel: string, _event: string, _args: unknown) => {});
  const manager = new WorkspaceManager(
    storage,
    new WorkspaceStorage(path.join(dir, "workspace"), () => new Database(":memory:")),
    new StateService(path.join(dir, "state.json")),
    broadcast,
  );
  try {
    const a = manager.create({ rootPath: path.join(dir, "a") });
    const b = manager.create({ rootPath: path.join(dir, "b") });
    const moved = manager.create({ rootPath: path.join(dir, "moved") });
    manager.update(a.id, { pinned: true });
    manager.update(b.id, { pinned: true });
    if (wasPinned) manager.update(moved.id, { pinned: true });
    storage.updateSortOrder(a.id, { pinnedSortOrder: 1, sortOrder: 0 });
    storage.updateSortOrder(b.id, { pinnedSortOrder: 2, sortOrder: 0 });
    broadcast.mockClear();

    manager.reorder(moved.id, { targetGroup: "pinned", beforeId: b.id });

    expect(broadcast).toHaveBeenCalledTimes(1);
    const [channel, event, payload] = broadcast.mock.calls[0];
    expect([channel, event]).toEqual(["workspace", "reordered"]);
    const { orders } = WorkspaceReorderedEventSchema.parse(payload);
    expect(orders).toEqual([
      { id: a.id, pinned: true, sortOrder: 0, pinnedSortOrder: 1024 },
      { id: b.id, pinned: true, sortOrder: 0, pinnedSortOrder: 2048 },
      { id: moved.id, pinned: true, sortOrder: 0, pinnedSortOrder: 1536 },
    ]);
  } finally {
    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
