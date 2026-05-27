import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { showItemInFolderHandler } from "../../../../src/main/features/shell/workspace-reveal";
import { FS_ERROR } from "../../../../src/shared/fs/errors";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174000";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-workspace-reveal-"));
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
  };
}

describe("showItemInFolderHandler", () => {
  it("reveals an existing local workspace path through Electron shell", async () => {
    const filePath = path.join(tmpRoot, "src", "index.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "export {};\n");
    const shell = { showItemInFolder: mock((_absPath: string) => {}) };

    await showItemInFolderHandler(makeManager(makeLocalWorkspace()) as never, shell)({
      workspaceId: WORKSPACE_ID,
      relPath: "src/index.ts",
    });

    expect(shell.showItemInFolder).toHaveBeenCalledWith(filePath);
  });

  it("rejects SSH workspaces with UNSUPPORTED_REMOTE fs error code", async () => {
    const shell = { showItemInFolder: mock((_absPath: string) => {}) };
    const workspace: WorkspaceMeta = {
      ...makeLocalWorkspace(),
      rootPath: "/srv/repo",
      location: { kind: "ssh", host: "dev.example.com", remotePath: "/srv/repo" },
    };

    await expect(
      showItemInFolderHandler(makeManager(workspace) as never, shell)({
        workspaceId: WORKSPACE_ID,
        relPath: "src/index.ts",
      }),
    ).rejects.toThrow(`${FS_ERROR.UNSUPPORTED_REMOTE}: ${WORKSPACE_ID}`);

    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("re-throws non-SSH errors unchanged", async () => {
    // Simulate a workspace-not-found error (not UnsupportedSshWorkspaceError)
    const shell = { showItemInFolder: mock((_absPath: string) => {}) };
    const emptyManager = { list: () => [] };

    await expect(
      showItemInFolderHandler(emptyManager as never, shell)({
        workspaceId: WORKSPACE_ID,
        relPath: "src/index.ts",
      }),
    ).rejects.toThrow("workspace not found");

    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });
});
