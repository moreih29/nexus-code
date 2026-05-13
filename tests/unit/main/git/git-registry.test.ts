import { describe, expect, it, mock } from "bun:test";
import type { AgentBackedProvider } from "../../../../src/main/bridge/fs/provider";
import { GitRegistry } from "../../../../src/main/git/git-registry";
import { GIT_RUN_METHOD, GIT_STATUS_METHOD } from "../../../../src/shared/protocol/agent/git";
import {
  DEFAULT_GIT_OPERATION_STATE,
  DEFAULT_REPO_CAPABILITIES,
  type GitStatus,
} from "../../../../src/shared/types/git";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174020";

function makeManager(
  workspaces: WorkspaceMeta[],
  provider = fakeAgentProvider(),
  activeId: string | null = workspaces[0]?.id ?? null,
) {
  return {
    list: (): WorkspaceMeta[] => workspaces,
    getActiveId: () => activeId,
    requireContext: (id: string) => {
      const workspace = workspaces.find((candidate) => candidate.id === id);
      if (!workspace) throw new Error(`workspace not found: ${id}`);
      return { fs: provider };
    },
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

function makeLocalWorkspace(rootPath = "/Users/test/repo"): WorkspaceMeta {
  return {
    id: WORKSPACE_ID,
    name: "local-workspace",
    rootPath,
    location: { kind: "local", rootPath },
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date().toISOString(),
    tabs: [],
  };
}

function makeRegistry(
  workspaces: WorkspaceMeta[],
  provider = fakeAgentProvider(),
  activeId: string | null = workspaces[0]?.id ?? null,
) {
  const broadcast = mock((_channel: string, _event: string, _payload: unknown) => {});
  const registry = new GitRegistry(
    makeManager(workspaces, provider, activeId) as never,
    broadcast,
    {
      path: "/usr/bin/git",
      version: "test",
    },
  );
  return { registry, broadcast };
}

describe("GitRegistry agent-backed workspaces", () => {
  it("detects an SSH repository through the required agent provider", async () => {
    const workspace = makeSshWorkspace();
    const { registry } = makeRegistry([workspace]);

    const repo = await registry.getOrDetect(WORKSPACE_ID);

    expect(repo?.topLevel).toBe(workspace.rootPath);
    expect(repo?.gitDir).toBe(`${workspace.rootPath}/.git`);
  });

  it("reads repo info and status through the required agent provider", async () => {
    const workspace = makeSshWorkspace();
    const { registry, broadcast } = makeRegistry([workspace]);

    expect(registry.getRepoInfo(WORKSPACE_ID)).toEqual({ kind: "detecting" });
    const status = await registry.refreshStatus(WORKSPACE_ID);

    expect(status).toEqual(cleanStatus());
    expect(broadcast).toHaveBeenCalledWith("git", "statusChanged", {
      workspaceId: WORKSPACE_ID,
      status,
    });
  });

  it("returns an active local clone execution context", () => {
    const workspace = makeLocalWorkspace();
    const { registry } = makeRegistry([workspace], fakeAgentProvider("local"));

    const context = registry.getCloneExecutionContext();

    expect(context.workspaceId).toBe(WORKSPACE_ID);
    expect(context.bin).toEqual({ path: "/usr/bin/git", version: "test" });
    expect(context.cwd).toBe(workspace.rootPath);
    expect(context.executor).toBeDefined();
  });

  it("creates a transient local clone context when no active workspace is available", () => {
    const workspace = makeLocalWorkspace();
    const { registry } = makeRegistry([workspace], fakeAgentProvider("local"), null);

    const context = registry.getCloneExecutionContext(undefined, "/tmp/clone-parent");

    expect(context.workspaceId).toBe("local-clone");
    expect(context.bin).toEqual({ path: "/usr/bin/git", version: "test" });
    expect(context.cwd).toBe("/tmp/clone-parent");
    expect(context.executor).toBeDefined();
    context.dispose?.();
  });

  it("rejects transient clone context without an absolute destination", () => {
    const workspace = makeLocalWorkspace();
    const { registry } = makeRegistry([workspace], fakeAgentProvider("local"), null);

    expect(() => registry.getCloneExecutionContext(undefined, "relative/path")).toThrow(
      /Clone destination must be absolute/,
    );
  });

  it("blocks SSH clone execution until remote destination cleanup is safe", () => {
    const workspace = makeSshWorkspace();
    const { registry } = makeRegistry([workspace], fakeAgentProvider("ssh"));

    expect(() => registry.getCloneExecutionContext(WORKSPACE_ID)).toThrow(
      /SSH workspaces do not support Git clone/,
    );
  });

  it("uses a transient local clone context when the active workspace is SSH but not requested", () => {
    const workspace = makeSshWorkspace();
    const { registry } = makeRegistry([workspace], fakeAgentProvider("ssh"));

    const context = registry.getCloneExecutionContext(undefined, "/tmp/clone-parent");

    expect(context.workspaceId).toBe("local-clone");
    expect(context.cwd).toBe("/tmp/clone-parent");
    context.dispose?.();
  });
});

/** Builds the minimal agent provider required by GitRegistry's non-optional executor path. */
function fakeAgentProvider(kind: "local" | "ssh" = "ssh"): AgentBackedProvider {
  const fail = async (): Promise<never> => {
    throw new Error("unexpected filesystem provider call");
  };
  return {
    kind,
    readdir: fail,
    stat: fail,
    readFile: fail,
    readAbsolute: fail,
    writeFile: fail,
    createFile: fail,
    mkdir: fail,
    unlink: fail,
    rmdir: fail,
    rename: fail,
    callAgentMethod: async (method: string, params?: unknown) => {
      if (method === GIT_RUN_METHOD) {
        const cwd = readCwd(params);
        return { stdout: `${cwd}\n${cwd}/.git\n`, stderr: "", code: 0 };
      }
      if (method === GIT_STATUS_METHOD) return cleanStatus();
      throw new Error(`unexpected agent method: ${method}`);
    },
    onAgentEvent: () => () => {},
    isAgentAvailable: () => true,
  };
}

function readCwd(params: unknown): string {
  if (
    typeof params === "object" &&
    params !== null &&
    typeof (params as { cwd?: unknown }).cwd === "string"
  ) {
    return (params as { cwd: string }).cwd;
  }
  throw new Error("expected git params cwd");
}

function cleanStatus(): GitStatus {
  return {
    merge: [],
    staged: [],
    working: [],
    untracked: [],
    branch: null,
    capabilities: { ...DEFAULT_REPO_CAPABILITIES },
    operationState: DEFAULT_GIT_OPERATION_STATE,
    lastFetchedAt: null,
  };
}
