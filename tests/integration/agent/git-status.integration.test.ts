/**
 * Round-trip tests for the semantic git.status agent method.
 *
 * These cases use the real Go agent and the real git binary against temporary
 * repositories so the test covers the wire method, Go porcelain parsing,
 * metadata fan-out, and the shared GitStatusSchema at the TS boundary.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalChannel } from "../../../src/main/agent/local-channel";
import { GIT_STATUS_METHOD } from "../../../src/shared/protocol/agent/git";
import { type GitStatus, GitStatusSchema } from "../../../src/shared/types/git";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const goAvailable = spawnSync("go", ["version"]).status === 0;
const gitAvailable = spawnSync("git", ["--version"]).status === 0;
let binPath = "";
let buildDir = "";
let gitHome = "";

type AgentChannel = ReturnType<typeof createLocalChannel>;

interface StatusRead {
  readonly raw: Record<string, unknown>;
  readonly status: GitStatus;
}

describe("agent git.status round-trip", () => {
  if (!goAvailable || !gitAvailable) {
    it("skips when go or git is unavailable", () => {});
    return;
  }

  beforeAll(async () => {
    buildDir = await fs.mkdtemp(path.join(tmpdir(), "agent-git-status-build-"));
    gitHome = path.join(buildDir, "git-home");
    await fs.mkdir(gitHome);
    binPath = path.join(buildDir, "agent");
    const build = spawnSync("go", ["build", "-o", binPath, "./cmd/agent"], {
      cwd: REPO_ROOT,
    });
    if (build.status !== 0) {
      throw new Error(`go build failed: ${build.stderr.toString()}`);
    }
  });

  afterAll(async () => {
    if (buildDir) {
      await fs.rm(buildDir, { recursive: true, force: true });
    }
    binPath = "";
    buildDir = "";
    gitHome = "";
  });

  it("reports a clean repository with null upstream, null FETCH_HEAD, and operationState none", async () => {
    await withStatusRepo(async ({ root, channel }) => {
      await initRepo(root);
      await writeFile(root, "tracked.txt", "clean\n");
      commitAll(root, "initial commit");

      const { raw, status } = await readStatus(channel, root);

      expect(status.branch).toEqual({
        current: "main",
        upstream: null,
        ahead: 0,
        behind: 0,
        isUnborn: false,
      });
      expect(rawBranch(raw).upstream).toBeNull();
      expect(raw.lastFetchedAt).toBeNull();
      expect(status.lastFetchedAt).toBeNull();
      expect(raw.operationState).toEqual({ kind: "none" });
      expect(status.operationState).toEqual({ kind: "none" });
      expect(status.capabilities).toEqual({
        hasHEAD: true,
        remotes: [],
        stashCount: 0,
        tagCount: 0,
      });
      expect(status.merge).toEqual([]);
      expect(status.staged).toEqual([]);
      expect(status.working).toEqual([]);
      expect(status.untracked).toEqual([]);
    });
  }, 30_000);

  it("groups staged, working, and untracked entries while preserving null conflictType", async () => {
    await withStatusRepo(async ({ root, channel }) => {
      await initRepo(root);
      await writeFile(root, "tracked.txt", "base\n");
      commitAll(root, "initial commit");

      await writeFile(root, "staged.txt", "staged\n");
      git(root, ["add", "staged.txt"]);
      await writeFile(root, "tracked.txt", "base\nworking\n");
      await writeFile(root, "untracked.txt", "new\n");

      const { raw, status } = await readStatus(channel, root);
      const staged = status.staged.find((entry) => entry.relPath === "staged.txt");
      const working = status.working.find((entry) => entry.relPath === "tracked.txt");
      const untracked = status.untracked.find((entry) => entry.relPath === "untracked.txt");

      expect(staged?.xy).toBe("A.");
      expect(staged?.conflictType).toBeNull();
      expect(working?.xy).toBe(".M");
      expect(working?.conflictType).toBeNull();
      expect(untracked?.xy).toBe("??");

      const rawWorking = rawStatusEntry(raw, "working", "tracked.txt");
      expect(Object.hasOwn(rawWorking, "conflictType")).toBe(true);
      expect(rawWorking.conflictType).toBeNull();
    });
  }, 30_000);

  it("reports merge conflicts and merge operation state from a real conflicted merge", async () => {
    await withStatusRepo(async ({ root, channel }) => {
      await createDivergedBranches(root, {
        branchName: "feature",
        filePath: "conflict.txt",
        mainContent: "main\n",
        otherContent: "feature\n",
      });

      const merge = gitAllowFailure(root, ["merge", "feature"]);
      expect(merge.status).not.toBe(0);

      const { status } = await readStatus(channel, root);
      const conflict = status.merge.find((entry) => entry.relPath === "conflict.txt");

      expect(conflict?.xy).toBe("UU");
      expect(conflict?.conflictType).toBe("both-modified");
      expect(status.operationState.kind).toBe("merge");
      if (status.operationState.kind === "merge") {
        expect(status.operationState.headRef).toBe("main");
        expect(status.operationState.mergeRef).toBeString();
        expect(status.operationState.conflictCount).toBe(1);
      }
    });
  }, 30_000);

  it("reports detached HEAD as branch null without losing HEAD capability", async () => {
    await withStatusRepo(async ({ root, channel }) => {
      await initRepo(root);
      await writeFile(root, "tracked.txt", "base\n");
      commitAll(root, "initial commit");
      git(root, ["checkout", "--detach", "HEAD"]);

      const { raw, status } = await readStatus(channel, root);

      expect(raw.branch).toBeNull();
      expect(status.branch).toBeNull();
      expect(status.capabilities.hasHEAD).toBe(true);
      expect(status.operationState).toEqual({ kind: "none" });
    });
  }, 30_000);

  it("reports an unborn repository with branch metadata and hasHEAD false", async () => {
    await withStatusRepo(async ({ root, channel }) => {
      await initRepo(root);

      const { raw, status } = await readStatus(channel, root);

      expect(status.branch).toEqual({
        current: "main",
        upstream: null,
        ahead: 0,
        behind: 0,
        isUnborn: true,
      });
      expect(rawBranch(raw).upstream).toBeNull();
      expect(status.capabilities.hasHEAD).toBe(false);
      expect(status.operationState).toEqual({ kind: "none" });
    });
  }, 30_000);

  it("reports rebase operation state from a real conflicted rebase", async () => {
    await withStatusRepo(async ({ root, channel }) => {
      await createDivergedBranches(root, {
        branchName: "topic",
        filePath: "rebase.txt",
        mainContent: "main rebase\n",
        otherContent: "topic rebase\n",
      });
      git(root, ["checkout", "topic"]);

      const rebase = gitAllowFailure(root, ["rebase", "main"]);
      expect(rebase.status).not.toBe(0);

      const { status } = await readStatus(channel, root);

      expect(status.operationState.kind).toBe("rebase");
      expect(status.merge.some((entry) => entry.relPath === "rebase.txt")).toBe(true);
      if (status.operationState.kind === "rebase") {
        expect(status.operationState.conflictCount).toBe(status.merge.length);
        expect(status.operationState.doneCount).toBeGreaterThanOrEqual(0);
        expect(status.operationState.totalCount).toBeGreaterThanOrEqual(1);
      }
    });
  }, 30_000);

  it("reports FETCH_HEAD mtime when the marker exists", async () => {
    await withStatusRepo(async ({ root, channel }) => {
      await initRepo(root);
      await writeFile(root, "tracked.txt", "base\n");
      commitAll(root, "initial commit");

      const fetchedAt = 1_700_000_000_000;
      const fetchHead = path.join(root, ".git", "FETCH_HEAD");
      await fs.writeFile(fetchHead, "0000000000000000000000000000000000000000\t\tbranch 'main'\n");
      await fs.utimes(fetchHead, new Date(fetchedAt), new Date(fetchedAt));

      const { raw, status } = await readStatus(channel, root);

      expect(typeof raw.lastFetchedAt).toBe("number");
      expect(status.lastFetchedAt).not.toBeNull();
      if (status.lastFetchedAt !== null) {
        expect(Math.abs(status.lastFetchedAt - fetchedAt)).toBeLessThan(1_500);
      }
    });
  }, 30_000);

  it("rejects corrupted repositories instead of returning a status snapshot", async () => {
    await withStatusRepo(async ({ root, channel }) => {
      await initRepo(root);
      await writeFile(root, "tracked.txt", "base\n");
      commitAll(root, "initial commit");
      await fs.writeFile(path.join(root, ".git", "HEAD"), "not a ref\n");

      const code = await callExpectErrorCode(channel, GIT_STATUS_METHOD, { cwd: root });

      expect(code).toBe("server.request-failed");
    });
  }, 30_000);
});

/**
 * Creates one temporary workspace, starts a real local agent channel for it,
 * and guarantees both process and filesystem cleanup after the case finishes.
 */
async function withStatusRepo(
  run: (context: { root: string; channel: AgentChannel }) => Promise<void>,
): Promise<void> {
  if (!binPath) throw new Error("agent binary path is not initialized");
  const root = await fs.mkdtemp(path.join(tmpdir(), "agent-git-status-root-"));
  const channel = createLocalChannel({ binaryPath: binPath, rootPath: root });
  try {
    await channel.ready;
    await run({ root, channel });
  } finally {
    channel.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

/**
 * Initializes a temporary repository with deterministic branch and author
 * settings, avoiding user-global git configuration and default-branch drift.
 */
async function initRepo(root: string): Promise<void> {
  git(root, ["init"]);
  git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(root, ["config", "user.name", "Nexus Test"]);
  git(root, ["config", "user.email", "nexus-test@example.invalid"]);
  git(root, ["config", "commit.gpgSign", "false"]);
  git(root, ["config", "core.autocrlf", "false"]);
}

/**
 * Writes a UTF-8 file inside the temporary repository, creating parent
 * directories when a scenario needs nested paths.
 */
async function writeFile(root: string, relPath: string, content: string): Promise<void> {
  const absolutePath = path.join(root, relPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
}

/**
 * Commits all current repository changes with a stable message and no signing
 * side effects, failing fast when the fixture setup is not as expected.
 */
function commitAll(root: string, message: string): void {
  git(root, ["add", "."]);
  git(root, ["commit", "--no-gpg-sign", "-m", message]);
}

/**
 * Creates a base commit plus a named branch and main branch that edit the same
 * file differently, so callers can trigger deterministic merge/rebase conflicts.
 */
async function createDivergedBranches(
  root: string,
  options: {
    readonly branchName: string;
    readonly filePath: string;
    readonly mainContent: string;
    readonly otherContent: string;
  },
): Promise<void> {
  await initRepo(root);
  await writeFile(root, options.filePath, "base\n");
  commitAll(root, "base");

  git(root, ["checkout", "-b", options.branchName]);
  await writeFile(root, options.filePath, options.otherContent);
  commitAll(root, `${options.branchName} change`);

  git(root, ["checkout", "main"]);
  await writeFile(root, options.filePath, options.mainContent);
  commitAll(root, "main change");
}

/**
 * Calls git.status through the real agent channel and validates the response
 * with the shared GitStatusSchema before returning either parsed or raw fields.
 */
async function readStatus(channel: AgentChannel, root: string): Promise<StatusRead> {
  const raw = asRecord(await channel.call(GIT_STATUS_METHOD, { cwd: root }), "git.status result");
  return { raw, status: GitStatusSchema.parse(raw) };
}

/**
 * Runs a git command expected to succeed and throws with stdout/stderr context
 * if fixture setup encountered a non-zero exit.
 */
function git(root: string, args: readonly string[]): SpawnSyncReturns<Buffer> {
  const result = spawnSync("git", [...args], { cwd: root, env: gitEnv() });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with ${result.status}\nstdout: ${result.stdout.toString()}\nstderr: ${result.stderr.toString()}`,
    );
  }
  return result;
}

/**
 * Runs a git command whose failure is part of the fixture setup, returning the
 * raw spawn result so the test can assert it really entered the conflict path.
 */
function gitAllowFailure(root: string, args: readonly string[]): SpawnSyncReturns<Buffer> {
  return spawnSync("git", [...args], { cwd: root, env: gitEnv() });
}

/**
 * Provides a hermetic git environment for temporary repos, including C locale
 * output and no dependency on the developer's global git config.
 */
function gitEnv(): NodeJS.ProcessEnv {
  if (!gitHome) throw new Error("git HOME is not initialized");
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Nexus Test",
    GIT_AUTHOR_EMAIL: "nexus-test@example.invalid",
    GIT_COMMITTER_NAME: "Nexus Test",
    GIT_COMMITTER_EMAIL: "nexus-test@example.invalid",
    HOME: gitHome,
    XDG_CONFIG_HOME: gitHome,
    LANG: "C",
    LC_ALL: "C",
  };
}

/**
 * Wraps channel.call to assert the server error path and return the stable
 * wire code attached by the NDJSON pipe.
 */
async function callExpectErrorCode(
  channel: AgentChannel,
  method: string,
  params: unknown,
): Promise<string> {
  try {
    const result = await channel.call(method, params);
    throw new Error(`expected error for ${method}, got result: ${JSON.stringify(result)}`);
  } catch (error) {
    const code = (error as Error & { code?: string }).code;
    if (typeof code !== "string") {
      throw new Error(
        `expected error.code on rejection for ${method}, got: ${(error as Error).message}`,
      );
    }
    return code;
  }
}

/**
 * Narrows unknown JSON values to object records for raw-wire trap assertions.
 */
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Reads the raw branch object, preserving null-vs-empty-string assertions that
 * GitStatusSchema defaults would otherwise make less visible.
 */
function rawBranch(raw: Record<string, unknown>): Record<string, unknown> {
  return asRecord(raw.branch, "git.status branch");
}

/**
 * Finds one raw status entry in a named group for assertions on fields such as
 * conflictType that are intentionally null on non-conflict records.
 */
function rawStatusEntry(
  raw: Record<string, unknown>,
  group: "merge" | "staged" | "working" | "untracked",
  relPath: string,
): Record<string, unknown> {
  const value = raw[group];
  if (!Array.isArray(value)) throw new Error(`git.status ${group} is not an array`);
  const found = value
    .map((entry) => asRecord(entry, `git.status ${group} entry`))
    .find((entry) => entry.relPath === relPath);
  if (!found) throw new Error(`missing ${group} entry for ${relPath}`);
  return found;
}
