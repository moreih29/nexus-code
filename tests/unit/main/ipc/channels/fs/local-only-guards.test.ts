import { describe, expect, it, mock } from "bun:test";
import {
  unwatchHandler,
  watchHandler,
} from "../../../../../../src/main/features/fs/ipc/watch-handlers";

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174010";

describe("fs agent-backed SSH workspace delegation", () => {
  // ensureRoot hydrates persisted expanded rels via fs.watch. When the
  // user has deleted those folders externally between sessions the agent
  // throws NOT_FOUND. Before envelope-wrapping, that rejection reached
  // Electron's `ipcMain.handle` and printed a per-row "Error occurred in
  // handler for 'ipc:call': Error: NOT_FOUND: …" — same family of noise we
  // already silenced for readdir/stat. The handler must now return the
  // typed `ipcErr` envelope instead of throwing.
  it("watch returns a typed ipcErr envelope on fs error (no rethrow)", async () => {
    const watcher = {
      watch: mock(async (_workspaceId: string, _relPath: string) => {
        throw new Error("NOT_FOUND: /srv/repo/stale");
      }),
      unwatch: mock(async (_workspaceId: string, _relPath: string) => {}),
    };

    const result = await watchHandler(watcher as never)({
      workspaceId: WORKSPACE_ID,
      relPath: "stale",
    });

    expect(result).toMatchObject({
      ok: false,
      kind: "fs-error",
      message: "NOT_FOUND: /srv/repo/stale",
    });
  });

  it("unwatch returns a typed ipcErr envelope on fs error (no rethrow)", async () => {
    const watcher = {
      watch: mock(async (_workspaceId: string, _relPath: string) => {}),
      unwatch: mock(async (_workspaceId: string, _relPath: string) => {
        throw new Error("NOT_FOUND: /srv/repo/stale");
      }),
    };

    const result = await unwatchHandler(watcher as never)({
      workspaceId: WORKSPACE_ID,
      relPath: "stale",
    });

    expect(result).toMatchObject({
      ok: false,
      kind: "fs-error",
      message: "NOT_FOUND: /srv/repo/stale",
    });
  });

  it("watch re-throws genuine bugs that are not fs-error coded", async () => {
    const watcher = {
      watch: mock(async (_workspaceId: string, _relPath: string) => {
        throw new Error("agent channel disposed");
      }),
      unwatch: mock(async (_workspaceId: string, _relPath: string) => {}),
    };

    await expect(
      watchHandler(watcher as never)({
        workspaceId: WORKSPACE_ID,
        relPath: "anywhere",
      }),
    ).rejects.toThrow("agent channel disposed");
  });
});
