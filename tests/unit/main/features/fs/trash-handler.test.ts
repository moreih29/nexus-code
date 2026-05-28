/**
 * trashHandler — main-process handler tests.
 *
 * The handler is local-workspace-only: SSH workspaces must surface
 * UNSUPPORTED_REMOTE rather than reaching `shell.trashItem`. ENOENT on
 * the underlying path is idempotent (stale-row safety).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trashHandler } from "../../../../../src/main/features/fs/ipc/trash-handler";
import { FS_ERROR } from "../../../../../src/shared/fs/errors";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174000";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-trash-handler-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeManager(workspace: WorkspaceMeta) {
  return { list: () => [workspace] };
}

function makeLocalWorkspace(): WorkspaceMeta {
  return {
    id: WORKSPACE_ID,
    name: "workspace",
    rootPath: tmpRoot,
    location: { kind: "local", rootPath: tmpRoot },
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date().toISOString(),
    tabs: [],
    sortOrder: 0,
    pinnedSortOrder: 0,
  };
}

describe("trashHandler", () => {
  it("moves an existing local workspace path to the OS trash via shell.trashItem", async () => {
    const filePath = path.join(tmpRoot, "doomed.txt");
    fs.writeFileSync(filePath, "x");

    const shell = { trashItem: mock(async (_abs: string) => {}) };

    await trashHandler(
      makeManager(makeLocalWorkspace()) as never,
      shell,
    )({
      workspaceId: WORKSPACE_ID,
      relPath: "doomed.txt",
    });

    expect(shell.trashItem).toHaveBeenCalledWith(filePath);
  });

  it("refuses SSH workspaces with UNSUPPORTED_REMOTE", async () => {
    const shell = { trashItem: mock(async (_abs: string) => {}) };
    const workspace: WorkspaceMeta = {
      ...makeLocalWorkspace(),
      rootPath: "/srv/repo",
      location: { kind: "ssh", host: "dev.example.com", remotePath: "/srv/repo" },
    };

    await expect(
      trashHandler(
        makeManager(workspace) as never,
        shell,
      )({
        workspaceId: WORKSPACE_ID,
        relPath: "doomed.txt",
      }),
    ).rejects.toThrow(`${FS_ERROR.UNSUPPORTED_REMOTE}: ${WORKSPACE_ID}`);

    expect(shell.trashItem).not.toHaveBeenCalled();
  });

  it("is idempotent on a missing path (no-op, no error)", async () => {
    const shell = { trashItem: mock(async (_abs: string) => {}) };

    await trashHandler(
      makeManager(makeLocalWorkspace()) as never,
      shell,
    )({
      workspaceId: WORKSPACE_ID,
      relPath: "never-existed.txt",
    });

    // Should NOT have called shell.trashItem — the access pre-check caught it.
    expect(shell.trashItem).not.toHaveBeenCalled();
  });

  it("surfaces shell.trashItem failure as PERMISSION_DENIED", async () => {
    const filePath = path.join(tmpRoot, "blocked.txt");
    fs.writeFileSync(filePath, "x");

    const shell = {
      trashItem: mock(async (_abs: string) => {
        throw new Error("trashItem failed");
      }),
    };

    await expect(
      trashHandler(
        makeManager(makeLocalWorkspace()) as never,
        shell,
      )({
        workspaceId: WORKSPACE_ID,
        relPath: "blocked.txt",
      }),
    ).rejects.toThrow(`${FS_ERROR.PERMISSION_DENIED}:`);
  });
});
