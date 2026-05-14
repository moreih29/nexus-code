/**
 * Round-trip coverage for Git stderr classification across the Go agent
 * envelope and the TypeScript GitError marker used by main-process callers.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalChannel } from "../../../src/main/agent/local-channel";
import { AgentFsProvider } from "../../../src/main/bridge/fs/agent-provider";
import { AgentGitExecutor } from "../../../src/main/features/git/bridge/agent-executor";
import { GitError, gitErrorFromAgent } from "../../../src/main/features/git/domain/git-error";
import {
  type AgentGitRunResult,
  AgentGitRunResultSchema,
  GIT_RUN_METHOD,
} from "../../../src/shared/protocol/agent/git";
import {
  ClassifiedErrorSchema,
  type GitActionHint,
  type GitErrorKind,
} from "../../../src/shared/types/git";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const FIXTURE_ROOT = path.join(REPO_ROOT, "tests/fixtures/git/stderr");
const LANG_C_ENV = { LANG: "C", LC_ALL: "C" } as const;

const goAvailable = spawnSync("go", ["version"]).status === 0;
const gitAvailable = spawnSync("git", ["--version"]).status === 0;
let agentBinPath = "";

type Channel = ReturnType<typeof createLocalChannel>;

interface ExpectedGitFailure {
  readonly kind: GitErrorKind;
  readonly hint?: GitActionHint;
  readonly message?: string;
}

interface PreparedGitCase {
  readonly root: string;
  readonly args: readonly string[];
  readonly cleanupRoot?: string;
}

interface RealGitCase {
  readonly name: string;
  readonly expected: ExpectedGitFailure;
  prepare(): Promise<PreparedGitCase>;
}

describe("agent git stderr classification round-trip", () => {
  if (!goAvailable) {
    it("skips when go is unavailable", () => {});
    return;
  }

  let binPath: string;
  let buildDir: string;

  beforeAll(async () => {
    buildDir = await fs.mkdtemp(path.join(tmpdir(), "agent-build-"));
    binPath = path.join(buildDir, "agent");
    agentBinPath = binPath;
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
  });

  if (!gitAvailable) {
    it("skips real git failure cases when git is unavailable", () => {});
  } else {
    it("classifies stable LANG=C git failures and converts them to GitError", async () => {
      for (const testCase of realGitCases) {
        let prepared: PreparedGitCase | undefined;
        try {
          prepared = await testCase.prepare();
          const result = await runAgentGit(prepared.root, prepared.args);

          expectAgentEnvelopeAndGitError(result, prepared.args, testCase.expected);
        } catch (error) {
          throw new Error(`${testCase.name} failed: ${(error as Error).message}`, { cause: error });
        } finally {
          if (prepared) {
            await fs.rm(prepared.cleanupRoot ?? prepared.root, { recursive: true, force: true });
          }
        }
      }
    }, 60_000);
  }

  it("classifies priority-collision and locale-drift fixtures through the real agent", async () => {
    const fixtureCases = [
      "priority-auth-required-over-auth",
      "priority-local-changes-over-conflict",
      "priority-force-push-over-non-fast-forward",
      "priority-protected-branch-over-push-rejected",
      "priority-pre-receive-over-push-rejected",
      "priority-branch-not-fully-merged-over-branch-not-merged",
      "unknown-locale-drift-not-repo-es",
    ] as const;

    const root = await fs.mkdtemp(path.join(tmpdir(), "agent-fake-git-root-"));
    const fakeGitDir = await fs.mkdtemp(path.join(tmpdir(), "agent-fake-git-bin-"));
    await writeFakeGit(fakeGitDir);
    const channel = createLocalChannel({
      binaryPath: binPath,
      rootPath: root,
      env: {
        PATH: `${fakeGitDir}${path.delimiter}${process.env.PATH ?? ""}`,
        NEXUS_GIT_STDERR_FIXTURE_ROOT: FIXTURE_ROOT,
      },
    });

    try {
      await channel.ready;

      for (const caseName of fixtureCases) {
        const expected = readExpectedFixture(caseName);
        const result = AgentGitRunResultSchema.parse(
          await channel.call(GIT_RUN_METHOD, {
            cwd: root,
            args: [caseName],
            env: LANG_C_ENV,
          }),
        );

        expect(result.stderr).toBe(readFixtureStderr(caseName));
        expectAgentEnvelopeAndGitError(result, [caseName], expected);
      }

      await expectExecutorGitError(channel, root, "priority-force-push-over-non-fast-forward");
    } finally {
      channel.dispose();
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(fakeGitDir, { recursive: true, force: true });
    }
  }, 30_000);
});

const realGitCases: readonly RealGitCase[] = [
  {
    name: "not-repo",
    expected: { kind: "not-repo" },
    prepare: async () => {
      const root = await fs.mkdtemp(path.join(tmpdir(), "agent-git-not-repo-"));
      return { root, args: ["status"] };
    },
  },
  {
    name: "no-head",
    expected: { kind: "no-head" },
    prepare: async () => {
      const root = await makeGitRoot("agent-git-no-head-");
      git(root, ["init", "-b", "main"]);
      return { root, args: ["log"] };
    },
  },
  {
    name: "missing pathspec",
    expected: { kind: "missing" },
    prepare: async () => {
      const root = await makeRepoWithCommit("agent-git-missing-");
      return { root, args: ["checkout", "--", "missing.txt"] };
    },
  },
  {
    name: "file not in HEAD",
    expected: { kind: "file-not-in-head" },
    prepare: async () => {
      const root = await makeRepoWithCommit("agent-git-file-not-in-head-");
      return { root, args: ["show", "HEAD:missing.txt"] };
    },
  },
  {
    name: "path outside repo",
    expected: { kind: "path-not-in-repo" },
    prepare: async () => {
      const base = await fs.mkdtemp(path.join(tmpdir(), "agent-git-outside-base-"));
      const root = path.join(base, "repo");
      await fs.mkdir(root);
      initializeRepoWithCommit(root);
      await fs.writeFile(path.join(base, "outside.txt"), "outside");
      return { root, args: ["add", "../outside.txt"], cleanupRoot: base };
    },
  },
  {
    name: "lock busy",
    expected: { kind: "lock-busy" },
    prepare: async () => {
      const root = await makeRepoWithCommit("agent-git-lock-");
      await fs.writeFile(path.join(root, "next.txt"), "next");
      await fs.writeFile(path.join(root, ".git/index.lock"), "");
      return { root, args: ["add", "next.txt"] };
    },
  },
  {
    name: "branch exists",
    expected: { kind: "branch-exists" },
    prepare: async () => {
      const root = await makeRepoWithCommit("agent-git-branch-exists-");
      git(root, ["branch", "feature"]);
      return { root, args: ["branch", "feature"] };
    },
  },
  {
    name: "branch name invalid",
    expected: { kind: "branch-name-invalid" },
    prepare: async () => {
      const root = await makeRepoWithCommit("agent-git-branch-invalid-");
      return { root, args: ["branch", "bad name"] };
    },
  },
  {
    name: "tag exists",
    expected: { kind: "tag-exists" },
    prepare: async () => {
      const root = await makeRepoWithCommit("agent-git-tag-exists-");
      git(root, ["tag", "v1.0.0"]);
      return { root, args: ["tag", "v1.0.0"] };
    },
  },
  {
    name: "tag not found",
    expected: { kind: "tag-not-found" },
    prepare: async () => {
      const root = await makeRepoWithCommit("agent-git-tag-not-found-");
      return { root, args: ["tag", "-d", "missing"] };
    },
  },
  {
    name: "remote exists",
    expected: { kind: "remote-exists" },
    prepare: async () => {
      const root = await makeRepoWithCommit("agent-git-remote-exists-");
      git(root, ["remote", "add", "origin", "https://example.com/repo.git"]);
      return { root, args: ["remote", "add", "origin", "https://example.com/other.git"] };
    },
  },
  {
    name: "remote name invalid",
    expected: { kind: "remote-name-invalid" },
    prepare: async () => {
      const root = await makeRepoWithCommit("agent-git-remote-name-invalid-");
      return { root, args: ["remote", "add", "bad name", "https://example.com/repo.git"] };
    },
  },
  {
    name: "no upstream",
    expected: { kind: "no-upstream" },
    prepare: async () => {
      const root = await makeRepoWithCommit("agent-git-no-upstream-");
      return { root, args: ["pull"] };
    },
  },
  {
    name: "no remote",
    expected: { kind: "no-remote" },
    prepare: async () => {
      const root = await makeRepoWithCommit("agent-git-no-remote-");
      return { root, args: ["push"] };
    },
  },
  {
    name: "no parent",
    expected: { kind: "no-parent" },
    prepare: async () => {
      const root = await makeRepoWithCommit("agent-git-no-parent-");
      return { root, args: ["show", "HEAD^"] };
    },
  },
  {
    name: "empty stash",
    expected: { kind: "empty-stash" },
    prepare: async () => {
      const root = await makeRepoWithCommit("agent-git-empty-stash-");
      return { root, args: ["stash", "pop"] };
    },
  },
  {
    name: "unrelated histories",
    expected: { kind: "unrelated-histories", hint: { kind: "allow-unrelated-histories" } },
    prepare: async () => {
      const root = await makeUnrelatedHistoriesRepo();
      return { root, args: ["merge", "other"] };
    },
  },
  {
    name: "empty cherry-pick",
    expected: { kind: "empty-commit", hint: { kind: "allow-empty" } },
    prepare: async () => {
      const { root, emptyCommitSha } = await makeEmptyCherryPickRepo();
      return { root, args: ["cherry-pick", emptyCommitSha] };
    },
  },
  {
    name: "non-fast-forward push",
    expected: { kind: "non-fast-forward", hint: { kind: "pull-then-retry" } },
    prepare: makeNonFastForwardPushRepo,
  },
];

/**
 * Runs one git.run request through a real local agent and returns the parsed
 * classified envelope.
 */
async function runAgentGit(root: string, args: readonly string[]): Promise<AgentGitRunResult> {
  const channel = createLocalChannel({ binaryPath: agentBinPath, rootPath: root });
  try {
    await channel.ready;
    return AgentGitRunResultSchema.parse(
      await channel.call(GIT_RUN_METHOD, {
        cwd: root,
        args: [...args],
        env: LANG_C_ENV,
      }),
    );
  } finally {
    channel.dispose();
  }
}

/**
 * Asserts both the wire envelope and the TS GitError conversion for one failed
 * git.run result.
 */
function expectAgentEnvelopeAndGitError(
  result: AgentGitRunResult,
  args: readonly string[],
  expected: ExpectedGitFailure,
): void {
  expect(result.code).not.toBe(0);
  expect(result.errorKind).toBe(expected.kind);
  expect(result.errorHint).toEqual(expected.hint);
  expect(result.errorMessage).toBe(expected.message ?? result.stderr.trim());

  const error = gitErrorFromAgent(result, args);
  expect(error).toBeInstanceOf(GitError);
  expect(error.kind).toBe(expected.kind);
  expect(error.hint).toEqual(expected.hint);
  expect(error.message).toBe(result.errorMessage);
  expect(error.stderr).toBe(result.stderr);
  expect(error.stdout).toBe(result.stdout);
  expect(error.code).toBe(result.code);
  expect(error.exitCode).toBe(result.code);
  expect(error.argv).toEqual([...args]);
}

/**
 * Verifies the production AgentGitExecutor failure switch re-wraps classified
 * agent results as GitError instances.
 */
async function expectExecutorGitError(
  channel: Channel,
  root: string,
  caseName: string,
): Promise<void> {
  const expected = readExpectedFixture(caseName);
  const provider = new AgentFsProvider("local", channel);
  const executor = new AgentGitExecutor(provider);

  try {
    await executor.run({ bin: "git", cwd: root, args: [caseName], env: LANG_C_ENV });
    throw new Error(`expected AgentGitExecutor to reject for ${caseName}`);
  } catch (error) {
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).kind).toBe(expected.kind);
    expect((error as GitError).hint).toEqual(expected.hint);
    expect((error as GitError).message).toBe(expected.message);
  }
}

/**
 * Creates the fake git executable used for fixture-backed stderr injection.
 */
async function writeFakeGit(dir: string): Promise<void> {
  const fakeGitPath = path.join(dir, "git");
  await fs.writeFile(
    fakeGitPath,
    `#!/bin/sh
fixture="$NEXUS_GIT_STDERR_FIXTURE_ROOT/$1/stderr.bin"
if [ "$1" = "" ] || [ ! -f "$fixture" ]; then
  echo "missing git stderr fixture: $1" >&2
  exit 2
fi
cat "$fixture" >&2
exit 1
`,
  );
  await fs.chmod(fakeGitPath, 0o755);
}

/**
 * Reads and validates the expected classified error for a fixture case.
 */
function readExpectedFixture(caseName: string): ExpectedGitFailure {
  const expectedPath = path.join(FIXTURE_ROOT, caseName, "expected.json");
  return ClassifiedErrorSchema.parse(JSON.parse(readFileSync(expectedPath, "utf8")));
}

/**
 * Reads the exact stderr fixture bytes as UTF-8 text.
 */
function readFixtureStderr(caseName: string): string {
  return readFileSync(path.join(FIXTURE_ROOT, caseName, "stderr.bin"), "utf8");
}

/**
 * Creates an empty temporary directory for a git repository.
 */
async function makeGitRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), prefix));
}

/**
 * Creates a temporary repository with one committed tracked file.
 */
async function makeRepoWithCommit(prefix: string): Promise<string> {
  const root = await makeGitRoot(prefix);
  initializeRepoWithCommit(root);
  return root;
}

/**
 * Initializes a repository with stable user config and one base commit.
 */
function initializeRepoWithCommit(root: string): void {
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "tester@example.test"]);
  git(root, ["config", "user.name", "Nexus Tester"]);
  writeFileSyncSafe(path.join(root, "tracked.txt"), "base\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "initial"]);
}

/**
 * Creates a repository with a second branch that has no shared history.
 */
async function makeUnrelatedHistoriesRepo(): Promise<string> {
  const root = await makeRepoWithCommit("agent-git-unrelated-");
  git(root, ["checkout", "--orphan", "other"]);
  git(root, ["rm", "-rf", "."]);
  writeFileSyncSafe(path.join(root, "other.txt"), "other\n");
  git(root, ["add", "other.txt"]);
  git(root, ["commit", "-m", "other"]);
  git(root, ["checkout", "main"]);
  return root;
}

/**
 * Creates a repository where cherry-picking the returned commit is empty.
 */
async function makeEmptyCherryPickRepo(): Promise<{ root: string; emptyCommitSha: string }> {
  const root = await makeRepoWithCommit("agent-git-empty-cherry-pick-");
  git(root, ["checkout", "-b", "feature"]);
  await fs.appendFile(path.join(root, "tracked.txt"), "feature\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "feature"]);
  const emptyCommitSha = git(root, ["rev-parse", "HEAD"]).stdout.trim();
  git(root, ["checkout", "main"]);
  git(root, ["cherry-pick", emptyCommitSha]);
  return { root, emptyCommitSha };
}

/**
 * Creates a clone whose push is rejected because the remote advanced.
 */
async function makeNonFastForwardPushRepo(): Promise<PreparedGitCase> {
  const base = await fs.mkdtemp(path.join(tmpdir(), "agent-git-non-ff-base-"));
  const remote = path.join(base, "remote.git");
  const first = path.join(base, "first");
  const second = path.join(base, "second");

  git(base, ["init", "--bare", remote]);
  git(base, ["clone", remote, first]);
  git(first, ["checkout", "-b", "main"]);
  git(first, ["config", "user.email", "tester@example.test"]);
  git(first, ["config", "user.name", "Nexus Tester"]);
  writeFileSyncSafe(path.join(first, "shared.txt"), "one\n");
  git(first, ["add", "shared.txt"]);
  git(first, ["commit", "-m", "one"]);
  git(first, ["push", "-u", "origin", "main"]);

  git(base, ["clone", remote, second]);
  git(second, ["checkout", "main"]);
  git(second, ["config", "user.email", "tester@example.test"]);
  git(second, ["config", "user.name", "Nexus Tester"]);

  await fs.appendFile(path.join(first, "shared.txt"), "two\n");
  git(first, ["commit", "-am", "two"]);
  git(first, ["push"]);

  writeFileSyncSafe(path.join(second, "second.txt"), "second\n");
  git(second, ["add", "second.txt"]);
  git(second, ["commit", "-m", "second"]);

  return { root: second, args: ["push", "origin", "main"], cleanupRoot: base };
}

/**
 * Runs a setup git command and throws with stdout/stderr if it fails.
 */
function git(cwd: string, args: readonly string[]): { stdout: string; stderr: string } {
  const result = spawnSync("git", [...args], {
    cwd,
    env: { ...process.env, ...LANG_C_ENV },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${
        result.stderr
      }`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * Synchronous fixture writer used only before setup git commands.
 */
function writeFileSyncSafe(filePath: string, content: string): void {
  if (existsSync(filePath)) {
    throw new Error(`refusing to overwrite setup fixture ${filePath}`);
  }
  writeFileSync(filePath, content);
}
