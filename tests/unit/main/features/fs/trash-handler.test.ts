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
    color: "auto",
    pinned: false,
    lastOpenedAt: new Date().toISOString(),
    tabs: [],
    sortOrder: 0,
    pinnedSortOrder: 0,
  };
}

describe("trashHandler", () => {
  it.skipIf(process.platform === "win32")(
    "sends a dangling symlink to the trash bridge",
    async () => {
      const link = path.join(tmpRoot, "link");
      await fs.promises.symlink("missing-target", link);
      const shell = { trashItem: mock(async (_abs: string) => {}) };

      await trashHandler(
        makeManager(makeLocalWorkspace()) as never,
        shell,
      )({
        workspaceId: WORKSPACE_ID,
        relPath: "link",
      });

      expect(shell.trashItem).toHaveBeenCalledWith(link);
    },
  );

  it("keeps a missing directory entry idempotent", async () => {
    const shell = { trashItem: mock(async (_abs: string) => {}) };

    await trashHandler(
      makeManager(makeLocalWorkspace()) as never,
      shell,
    )({
      workspaceId: WORKSPACE_ID,
      relPath: "already-removed",
    });

    expect(shell.trashItem).not.toHaveBeenCalled();
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
});
