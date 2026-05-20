import { describe, expect, it, mock } from "bun:test";
import type { AgentBackedProvider } from "../../../../src/main/features/fs/bridge/provider";
import { GitRegistry } from "../../../../src/main/features/git/domain/registry";
import {
  GIT_DETECT_METHOD,
  GIT_RUN_METHOD,
  GIT_STATUS_METHOD,
} from "../../../../src/shared/git/protocol";
import {
  DEFAULT_GIT_OPERATION_STATE,
  DEFAULT_REPO_CAPABILITIES,
  type GitStatus,
} from "../../../../src/shared/git/types";
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
    // getFs gates the async git paths (getOrDetect / refreshDetection /
    // reinit) on fs-provider readiness; the production WorkspaceManager
    // builds this around ensureProviderReady. Tests can resolve
    // immediately because the fake provider is wired from construction.
    getFs: async (id: string) => {
      const workspace = workspaces.find((candidate) => candidate.id === id);
      if (!workspace) throw new Error(`workspace not found: ${id}`);
      return provider;
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
      if (method === GIT_DETECT_METHOD) {
        const cwd = readCwd(params);
        return { kind: "repo", topLevel: cwd, gitDir: `${cwd}/.git` };
      }
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
