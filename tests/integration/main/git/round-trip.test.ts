import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitRegistry } from "../../../../src/main/git/git-registry";
import { registerGitChannel } from "../../../../src/main/ipc/channels/git";
import { DEFAULT_GIT_PANEL_STATE, type GitStatus } from "../../../../src/shared/types/git";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";
import {
  createIpcPair,
  installWindowForPair,
  resetInMemoryIpc,
  setupInMemoryRouter,
  waitFor,
} from "../../../helpers/ipc-pair";

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174022";
const gitOnPath = findGitOnPath();
const realGitTest = gitOnPath ? test : test.skip;

let tmpRoots: string[] = [];

beforeEach(() => {
  resetInMemoryIpc();
  tmpRoots = [];
});

afterEach(() => {
  resetInMemoryIpc();
  for (const root of tmpRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("git channel round-trip", () => {
  realGitTest("manual refresh re-detects a workspace initialized outside the panel", async () => {
    const gitPath = gitOnPath!;
    const root = makeTmpRoot();
    const pair = createIpcPair();
    installWindowForPair(pair);
    await registerRealGit(root, gitPath);

    const initialInfo = (await pair.window.ipc.call("git", "getRepoInfo", {
      workspaceId: WORKSPACE_ID,
    })) as { kind: string };
    expect(initialInfo.kind).toBe("non-repo");

    runGit(gitPath, root, ["init"]);

    const cachedInfo = (await pair.window.ipc.call("git", "getRepoInfo", {
      workspaceId: WORKSPACE_ID,
    })) as { kind: string };
    expect(cachedInfo.kind).toBe("non-repo");

    const refreshedInfo = (await pair.window.ipc.call("git", "refreshDetection", {
      workspaceId: WORKSPACE_ID,
    })) as { kind: string; topLevel?: string };
    expect(refreshedInfo).toMatchObject({ kind: "repo", topLevel: fs.realpathSync(root) });
  });

  realGitTest("stages, commits, refreshes, and broadcasts the resulting clean index", async () => {
    const gitPath = gitOnPath!;
    const root = makeTmpRoot();
    runGit(gitPath, root, ["init"]);
    runGit(gitPath, root, ["config", "user.name", "Nexus Test"]);
    runGit(gitPath, root, ["config", "user.email", "nexus@example.invalid"]);
    fs.writeFileSync(path.join(root, "README.md"), "initial\n", "utf8");
    runGit(gitPath, root, ["add", "README.md"]);
    runGit(gitPath, root, ["commit", "-m", "initial"]);

    fs.writeFileSync(path.join(root, "round trip file.txt"), "from renderer\n", "utf8");

    const pair = createIpcPair();
    installWindowForPair(pair);
    const statuses: GitStatus[] = [];
    const trace: string[] = [];
    pair.window.ipc.listen("git", "statusChanged", (payload) => {
      const status = (payload as { status: GitStatus }).status;
      statuses.push(status);
      trace.push(status.staged.length === 0 ? "event:clean" : "event:staged");
    });

    await registerRealGit(root, gitPath);

    await pair.window.ipc.call("git", "stage", {
      workspaceId: WORKSPACE_ID,
      relPaths: ["round trip file.txt"],
    });
    expect(latestStatus(statuses).staged.map((entry) => entry.relPath)).toEqual([
      "round trip file.txt",
    ]);

    const commit = pair.window.ipc
      .call("git", "commit", {
        workspaceId: WORKSPACE_ID,
        message: "commit from renderer round trip",
      })
      .then((result) => {
        trace.push("commit:resolved");
        return result as { sha: string };
      });

    await waitFor(
      () => statuses.some((status) => statusIsClean(status)),
      "expected clean statusChanged after commit",
    );
    const result = await commit;

    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(latestStatus(statuses)).toMatchObject({
      merge: [],
      staged: [],
      working: [],
      untracked: [],
    });
    expect(trace.indexOf("event:clean")).toBeGreaterThan(-1);
    expect(trace.indexOf("event:clean")).toBeLessThan(trace.indexOf("commit:resolved"));
  });
});

/** Registers the real git IPC channel against a tmp workspace and in-memory router. */
async function registerRealGit(root: string, gitPath: string): Promise<void> {
  const router = await setupInMemoryRouter();
  const workspace: WorkspaceMeta = {
    id: WORKSPACE_ID,
    name: "round-trip",
    rootPath: root,
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date().toISOString(),
    tabs: [],
  };
  const registry = new GitRegistry({ list: () => [workspace] } as never, router.broadcast, {
    path: gitPath,
    version: gitVersion(gitPath),
  });

  registerGitChannel(registry, {
    getGitPanelState: () => DEFAULT_GIT_PANEL_STATE,
    setGitPanelState: () => {},
  } as never);
}

/** Creates and tracks a temp directory for this round-trip scenario. */
function makeTmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-round-trip-"));
  tmpRoots.push(root);
  return root;
}

/** Runs a real git command as part of fixture setup, failing fast on stderr exits. */
function runGit(gitPath: string, cwd: string, args: string[]): string {
  return execFileSync(gitPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/** Resolves git from PATH only, so this file skips cleanly when PATH lacks git. */
function findGitOnPath(): string | null {
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    return execFileSync(locator, ["git"], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

/** Reads the version banner for GitRegistry metadata; behavior is not under test. */
function gitVersion(gitPath: string): string {
  return runGit(gitPath, process.cwd(), ["--version"])
    .replace(/^git version\s+/i, "")
    .trim();
}

/** Returns the newest broadcast status and fails loudly if no broadcast arrived. */
function latestStatus(statuses: GitStatus[]): GitStatus {
  const status = statuses.at(-1);
  if (!status) throw new Error("expected at least one statusChanged broadcast");
  return status;
}

/** Checks the clean post-commit state across every Source Control status group. */
function statusIsClean(status: GitStatus): boolean {
  return (
    status.merge.length === 0 &&
    status.staged.length === 0 &&
    status.working.length === 0 &&
    status.untracked.length === 0
  );
}
