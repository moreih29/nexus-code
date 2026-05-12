import { describe, expect, it, mock } from "bun:test";
import { GitRegistry } from "../../../../src/main/git/git-registry";
import { UnsupportedSshWorkspaceError } from "../../../../src/main/workspace/workspace-guards";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174020";

function makeManager(workspaces: WorkspaceMeta[]) {
  return {
    list: (): WorkspaceMeta[] => workspaces,
  };
}

function makeSshWorkspace(remotePath = "/srv/repo"): WorkspaceMeta {
  return {
    id: WORKSPACE_ID,
    name: "ssh-workspace",
    rootPath: remotePath,
    location: { kind: "ssh", host: "dev.example.com", remotePath },
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date().toISOString(),
    tabs: [],
  };
}

function makeRegistry(workspaces: WorkspaceMeta[]) {
  const broadcast = mock((_channel: string, _event: string, _payload: unknown) => {});
  const registry = new GitRegistry(makeManager(workspaces) as never, broadcast, {
    path: "/usr/bin/git",
    version: "test",
  });
  return { registry, broadcast };
}

describe("GitRegistry SSH workspace guards", () => {
  it("rejects repository detection before resolving an SSH rootPath as a local repo", async () => {
    const { registry, broadcast } = makeRegistry([makeSshWorkspace()]);

    await expect(registry.getOrDetect(WORKSPACE_ID)).rejects.toBeInstanceOf(
      UnsupportedSshWorkspaceError,
    );
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("rejects repo info and status paths with the unsupported SSH workspace error", async () => {
    const { registry } = makeRegistry([makeSshWorkspace()]);

    expect(() => registry.getRepoInfo(WORKSPACE_ID)).toThrow(UnsupportedSshWorkspaceError);
    await expect(registry.refreshStatus(WORKSPACE_ID)).rejects.toBeInstanceOf(
      UnsupportedSshWorkspaceError,
    );
  });
});
