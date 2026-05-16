/**
 * Integration coverage for the Phase 3 semantic git agent methods.
 *
 * These cases spawn the real Go agent and drive log/diff/blob/commitDetail
 * through the TypeScript AgentGitExecutor and GitRepository where that surface
 * preserves the domain fields under test. Blob metadata is also checked at the
 * wire method because the repository stream intentionally exposes only bytes.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  type ChildProcessWithoutNullStreams,
  type SpawnSyncReturns,
  spawn,
  spawnSync,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalChannel } from "../../../src/main/infra/agent/channel/local-channel";
import { AgentFsProvider } from "../../../src/main/features/fs/bridge/agent-provider";
import { AgentGitExecutor } from "../../../src/main/features/git/bridge/agent-executor";
import { GitRepository } from "../../../src/main/features/git/domain/repository";
import {
  AgentGitBlobChunkPayloadSchema,
  AgentGitBlobResultSchema,
  AgentGitLogBatchPayloadSchema,
  AgentGitLogResultSchema,
  GIT_BLOB_CHUNK_EVENT,
  GIT_BLOB_METHOD,
  GIT_LOG_BATCH_EVENT,
  GIT_LOG_METHOD,
} from "../../../src/shared/git/protocol";
import type { DiffChunk, DiffComplete } from "../../../src/shared/git/types";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const goAvailable = spawnSync("go", ["version"]).status === 0;
const gitAvailable = spawnSync("git", ["--version"]).status === 0;
const RUN_TIMEOUT_MS = 5_000;

let binPath = "";
let buildDir = "";
let gitHome = "";
let commitSequence = 0;

type AgentChannel = ReturnType<typeof createLocalChannel>;

interface GitTestContext {
  readonly root: string;
  readonly channel: AgentChannel;
  readonly provider: AgentFsProvider;
  readonly executor: AgentGitExecutor;
  readonly repo: GitRepository;
  readonly agentStderr: () => string;
}

interface WithGitRepoOptions {
  readonly channelEnv?: NodeJS.ProcessEnv;
  readonly captureAgentStderr?: boolean;
}

describe("agent git semantic streaming round-trip", () => {
  if (!goAvailable || !gitAvailable) {
    it("skips when go or git is unavailable", () => {});
    return;
  }

  beforeAll(async () => {
    buildDir = await fs.mkdtemp(path.join(tmpdir(), "agent-git-streaming-build-"));
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

  it("streams decorated log entries through GitRepository", async () => {
    await withGitRepo(async ({ root, repo }) => {
      await initRepo(root);
      await writeFile(root, "README.md", "one\n");
      commitAll(root, "initial commit");
      await writeFile(root, "README.md", "one\ntwo\n");
      const latestSha = commitAll(root, "second commit");
      git(root, ["tag", "v-stream"]);

      const { chunks, complete } = await drain(repo.log({ limit: 2 }));
      const entries = chunks.flatMap((chunk) => chunk.entries);

      expect(complete.count).toBe(2);
      expect(complete.hasMore).toBe(false);
      expect(entries).toHaveLength(2);
      expect(entries[0]?.sha).toBe(latestSha);
      expect(entries[0]?.subject).toBe("second commit");
      expect(entries[0]?.parents).toHaveLength(1);
      expect(entries[0]?.refs?.some((ref) => ref.kind === "tag" && ref.name === "v-stream")).toBe(
        true,
      );
      expect(entries[0]?.refs?.some((ref) => ref.kind === "branch" && ref.isHead)).toBe(true);
    });
  }, 30_000);

  it("honors log grep filtering through the semantic bridge", async () => {
    await withGitRepo(async ({ root, repo }) => {
      await initRepo(root);
      await writeFile(root, "notes.txt", "a\n");
      commitAll(root, "feat: apple");
      await writeFile(root, "notes.txt", "b\n");
      commitAll(root, "fix: banana");
      await writeFile(root, "notes.txt", "c\n");
      commitAll(root, "feat: carrot");

      const { chunks, complete } = await drain(repo.log({ grep: "feat", limit: 10 }));
      const subjects = chunks.flatMap((chunk) => chunk.entries.map((entry) => entry.subject));

      expect(complete.count).toBe(2);
      expect(complete.hasMore).toBe(false);
      expect(subjects).toEqual(["feat: carrot", "feat: apple"]);
    });
  }, 30_000);

  it("honors log path filtering through AgentGitExecutor", async () => {
    await withGitRepo(async ({ root, executor }) => {
      await initRepo(root);
      await writeFile(root, "a.txt", "a1\n");
      commitAll(root, "touch a once");
      await writeFile(root, "b.txt", "b1\n");
      commitAll(root, "touch b");
      await writeFile(root, "a.txt", "a2\n");
      commitAll(root, "touch a twice");

      const { chunks, complete } = await drain(
        executor.log({ cwd: root, paths: ["a.txt"], limit: 10 }),
      );
      const subjects = chunks.flatMap((chunk) => chunk.entries.map((entry) => entry.subject));

      expect(complete.count).toBe(2);
      expect(subjects).toEqual(["touch a twice", "touch a once"]);
    });
  }, 30_000);

  it("returns log limit=1 promptly with hasMore and no agent stderr leakage", async () => {
    await withGitRepo(
      async ({ root, repo, agentStderr }) => {
        await initRepo(root);
        await writeFile(root, "history.txt", "one\n");
        commitAll(root, "one");
        await writeFile(root, "history.txt", "two\n");
        commitAll(root, "two");
        await writeFile(root, "history.txt", "three\n");
        commitAll(root, "three");

        const startedAt = performance.now();
        const { chunks, complete } = await withTimeout(
          drain(repo.log({ limit: 1 })),
          RUN_TIMEOUT_MS,
          "git.log limit=1",
        );
        const elapsedMs = performance.now() - startedAt;
        const entries = chunks.flatMap((chunk) => chunk.entries);

        expect(elapsedMs).toBeLessThan(RUN_TIMEOUT_MS);
        expect(complete.count).toBe(1);
        expect(complete.hasMore).toBe(true);
        expect(entries.map((entry) => entry.subject)).toEqual(["three"]);
        expect(agentStderr()).toBe("");

        const followUp = await withTimeout(
          drain(repo.log({ limit: 1 })),
          RUN_TIMEOUT_MS,
          "follow-up log",
        );
        expect(followUp.complete.count).toBe(1);
      },
      { captureAgentStderr: true },
    );
  }, 30_000);

  it("streams working-tree diff text through GitRepository", async () => {
    await withGitRepo(async ({ root, repo }) => {
      await initRepo(root);
      await writeFile(root, "story.txt", "base\n");
      commitAll(root, "base");
      await writeFile(root, "story.txt", "base\nchanged\n");

      const { text, complete } = await drainDiff(
        repo.diff({ kind: "wt-vs-head", relPath: "story.txt" }),
      );

      expect(complete).toEqual({ bytes: Buffer.byteLength(text), truncated: false });
      expect(text).toContain("diff --git a/story.txt b/story.txt");
      expect(text).toContain("+changed");
    });
  }, 30_000);

  it("streams ref-vs-ref diff text through AgentGitExecutor", async () => {
    await withGitRepo(async ({ root, executor }) => {
      await initRepo(root);
      await writeFile(root, "compare.txt", "left\n");
      const left = commitAll(root, "left side");
      await writeFile(root, "compare.txt", "left\nright\n");
      const right = commitAll(root, "right side");

      const { text, complete } = await drainDiff(
        executor.diff({
          cwd: root,
          spec: { kind: "ref-vs-ref", leftRef: left, rightRef: right, relPath: "compare.txt" },
        }),
      );

      expect(complete.truncated).toBe(false);
      expect(text).toContain("diff --git a/compare.txt b/compare.txt");
      expect(text).toContain("+right");
    });
  }, 30_000);

  it("preserves a multibyte emoji split at a diff chunk byte boundary", async () => {
    await withGitRepo(async ({ root, executor }) => {
      await initRepo(root);
      const prefix = "a".repeat(80);
      await writeFile(root, "emoji.txt", `${prefix}\n`);
      commitAll(root, "emoji base");
      await writeFile(root, "emoji.txt", `${prefix}🙂\n`);

      const expectedDiff = gitStdout(root, ["diff", "--no-ext-diff", "HEAD", "--", "emoji.txt"]);
      const emojiIndex = expectedDiff.indexOf("🙂");
      expect(emojiIndex).toBeGreaterThan(0);
      const emojiByteStart = Buffer.byteLength(expectedDiff.slice(0, emojiIndex));
      const boundaryInsideEmoji = emojiByteStart + 1;

      const { chunks, complete } = await drain(
        executor.diff({
          cwd: root,
          spec: { kind: "wt-vs-head", relPath: "emoji.txt" },
          maxChunkBytes: boundaryInsideEmoji,
        }),
      );
      const text = chunks.map((chunk) => chunk.text).join("");

      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks.every((chunk) => !chunk.text.includes("\uFFFD"))).toBe(true);
      expect(text).toBe(expectedDiff);
      expect(complete).toEqual({ bytes: Buffer.byteLength(expectedDiff), truncated: false });
    });
  }, 30_000);

  it("reports diff truncation when maxBytes cuts a larger diff", async () => {
    await withGitRepo(async ({ root, executor }) => {
      await initRepo(root);
      await writeFile(root, "large.txt", "base\n");
      commitAll(root, "large base");
      await writeFile(root, "large.txt", `${"changed\n".repeat(80)}`);

      const { text, complete } = await drainDiff(
        executor.diff({
          cwd: root,
          spec: { kind: "wt-vs-head", relPath: "large.txt" },
          maxBytes: 120,
          maxChunkBytes: 32,
        }),
      );

      expect(complete.truncated).toBe(true);
      expect(complete.bytes).toBeGreaterThan(120);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(120);
      expect(text).toContain("diff --git");
    });
  }, 30_000);

  it("streams UTF-8 blob bytes through GitRepository", async () => {
    await withGitRepo(async ({ root, repo }) => {
      await initRepo(root);
      const content = "hello\n🙂\n";
      await writeFile(root, "blob.txt", content);
      commitAll(root, "blob text");

      const { chunks, complete } = await drain(repo.getFileBlob("HEAD", "blob.txt"));
      const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.chunk)));

      expect(bytes.toString("utf8")).toBe(content);
      expect(complete).toEqual({ bytes: Buffer.byteLength(content) });
    });
  }, 30_000);

  it("reports binary blob detection in the first wire chunk", async () => {
    await withGitRepo(async ({ root, channel }) => {
      await initRepo(root);
      const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x41, 0x42]);
      await writeBinaryFile(root, "bin.dat", binary);
      commitAll(root, "binary blob");

      const { result, chunks } = await readBlobWire(channel, root, {
        ref: "HEAD",
        relPath: "bin.dat",
        maxChunkBytes: 3,
      });

      expect(result.isBinary).toBe(true);
      expect(result.encoding).toBe("binary");
      expect(result.truncated).toBe(false);
      expect(result.size).toBe(binary.byteLength);
      expect(chunks[0]?.headerProbe).toMatchObject({
        isBinary: true,
        encoding: "binary",
        probeBytes: 3,
      });
      expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.chunk, "base64")))).toEqual(
        binary,
      );
    });
  }, 30_000);

  it("reports UTF-8 BOM blob detection in the first wire chunk", async () => {
    await withGitRepo(async ({ root, channel }) => {
      await initRepo(root);
      const content = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("bom text\n")]);
      await writeBinaryFile(root, "bom.txt", content);
      commitAll(root, "bom blob");

      const { result, chunks } = await readBlobWire(channel, root, {
        ref: "HEAD",
        relPath: "bom.txt",
        maxChunkBytes: 8,
      });

      expect(result.isBinary).toBe(false);
      expect(result.encoding).toBe("utf8-bom");
      expect(chunks[0]?.headerProbe?.encoding).toBe("utf8-bom");
      expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.chunk, "base64")))).toEqual(
        content,
      );
    });
  }, 30_000);

  it("reports blob truncation without streaming beyond maxBytes", async () => {
    await withGitRepo(async ({ root, channel }) => {
      await initRepo(root);
      const content = Buffer.from("0123456789abcdef".repeat(8));
      await writeBinaryFile(root, "large.bin", content);
      commitAll(root, "large blob");

      const { result, chunks } = await readBlobWire(channel, root, {
        ref: "HEAD",
        relPath: "large.bin",
        maxBytes: 19,
        maxChunkBytes: 5,
      });
      const streamed = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.chunk, "base64")));

      expect(result.truncated).toBe(true);
      expect(result.size).toBe(content.byteLength);
      expect(streamed).toEqual(content.subarray(0, 19));
    });
  }, 30_000);

  it("returns commitDetail metadata, body, and files through GitRepository", async () => {
    await withGitRepo(async ({ root, repo }) => {
      await initRepo(root);
      await writeFile(root, "detail.txt", "base\n");
      const sha = commitAll(root, "detail subject", "detail body\nsecond line");

      const detail = await repo.commitDetail(sha);

      expect(detail.sha).toBe(sha);
      expect(detail.parents).toEqual([]);
      expect(detail.subject).toBe("detail subject");
      expect(detail.author).toBe("Nexus Test");
      expect(detail.authorEmail).toBe("nexus-test@example.invalid");
      expect(detail.message).toContain("detail body");
      expect(detail.body).toBe("detail body\nsecond line");
      expect(detail.files).toEqual([{ status: "A", path: "detail.txt" }]);
    });
  }, 30_000);

  it("covers commitDetail for a merge commit", async () => {
    await withGitRepo(async ({ root, repo }) => {
      await initRepo(root);
      const mergeSha = await createMergeCommit(root);

      const detail = await repo.commitDetail(mergeSha);

      expect(detail.sha).toBe(mergeSha);
      expect(detail.parents).toHaveLength(2);
      expect(detail.subject).toBe("merge feature branch");
      expect(detail.files.some((file) => file.path === "feature.txt")).toBe(true);
    });
  }, 30_000);

  it("reports commitDetail rename changes with oldPath", async () => {
    await withGitRepo(async ({ root, repo }) => {
      await initRepo(root);
      await writeFile(root, "old-name.txt", "rename me\n");
      commitAll(root, "rename base");
      git(root, ["mv", "old-name.txt", "new-name.txt"]);
      const sha = commitAll(root, "rename file");

      const detail = await repo.commitDetail(sha);

      expect(detail.files).toEqual([
        { status: "R100", oldPath: "old-name.txt", path: "new-name.txt" },
      ]);
    });
  }, 30_000);

  it("uses source refs for all-scope log entries", async () => {
    await withGitRepo(async ({ root, executor }) => {
      await initRepo(root);
      await writeFile(root, "main.txt", "main\n");
      commitAll(root, "main base");
      git(root, ["checkout", "-b", "feature"]);
      await writeFile(root, "feature.txt", "feature\n");
      commitAll(root, "feature only");
      git(root, ["checkout", "main"]);

      const { chunks, complete } = await drain(
        executor.log({ cwd: root, scope: "all", limit: 10, source: true }),
      );
      const subjects = chunks.flatMap((chunk) => chunk.entries.map((entry) => entry.subject));

      expect(complete.count).toBe(2);
      expect(subjects).toContain("feature only");
      expect(subjects).toContain("main base");
    });
  }, 30_000);

  it("pre-aborted semantic methods throw AbortError consistently", async () => {
    await withGitRepo(async ({ root, repo }) => {
      await initRepo(root);
      await writeFile(root, "abort.txt", "base\n");
      const sha = commitAll(root, "abort base");
      await writeFile(root, "abort.txt", "base\nchanged\n");

      await expectAbortError(collect(repo.log({ limit: 1 }, abortedSignal())), "pre-aborted log");
      await expectAbortError(
        collect(repo.diff({ kind: "wt-vs-head", relPath: "abort.txt" }, abortedSignal())),
        "pre-aborted diff",
      );
      await expectAbortError(
        collect(repo.getFileBlob("HEAD", "abort.txt", abortedSignal())),
        "pre-aborted blob",
      );
      await expectAbortError(repo.commitDetail(sha, abortedSignal()), "pre-aborted commitDetail");
    });
  }, 30_000);

  it("active log, diff, and blob aborts surface AbortError and leave the channel usable", async () => {
    const fakeGitDir = await fs.mkdtemp(path.join(tmpdir(), "agent-fake-streaming-git-"));
    await writeSlowFakeGit(fakeGitDir);
    await withGitRepo(
      async ({ root, executor, channel }) => {
        await expectActiveStreamAbort(
          (signal) => executor.log({ cwd: root, limit: 200, signal }),
          (chunk) => expect(chunk.entries.length).toBeGreaterThan(0),
          "active log abort",
        );
        await expectActiveStreamAbort(
          (signal) =>
            executor.diff({
              cwd: root,
              spec: { kind: "wt-vs-head", relPath: "fake.txt" },
              maxChunkBytes: 16,
              signal,
            }),
          (chunk) => expect(chunk.text.length).toBeGreaterThan(0),
          "active diff abort",
        );
        await expectActiveStreamAbort(
          (signal) =>
            executor.blob({
              cwd: root,
              ref: "HEAD",
              relPath: "fake.bin",
              maxChunkBytes: 16,
              signal,
            }),
          (chunk) => expect(chunk.chunk.byteLength).toBeGreaterThan(0),
          "active blob abort",
        );

        const events: unknown[] = [];
        const unsubscribe = channel.on(GIT_LOG_BATCH_EVENT, (payload) => events.push(payload));
        try {
          const result = AgentGitLogResultSchema.parse(
            await withTimeout(
              channel.call(GIT_LOG_METHOD, {
                cwd: root,
                streamId: "post-abort-log",
                limit: 1,
              }),
              RUN_TIMEOUT_MS,
              "post-abort direct log",
            ),
          );
          const batches = events
            .map((payload) => AgentGitLogBatchPayloadSchema.parse(payload))
            .filter((payload) => payload.streamId === "post-abort-log");
          expect(result.count).toBe(1);
          expect(result.hasMore).toBe(true);
          expect(batches.flatMap((batch) => batch.entries).length).toBeGreaterThan(0);
        } finally {
          unsubscribe();
        }
      },
      {
        channelEnv: {
          PATH: `${fakeGitDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    ).finally(async () => {
      await fs.rm(fakeGitDir, { recursive: true, force: true });
    });
  }, 30_000);
});

/**
 * Creates one temporary repository, wires a real local agent channel to it,
 * and guarantees process/filesystem cleanup for each scenario.
 */
async function withGitRepo(
  run: (context: GitTestContext) => Promise<void>,
  options: WithGitRepoOptions = {},
): Promise<void> {
  if (!binPath) throw new Error("agent binary path is not initialized");
  const root = await fs.mkdtemp(path.join(tmpdir(), "agent-git-streaming-root-"));
  const stderrChunks: Buffer[] = [];
  const channel = createLocalChannel(
    {
      binaryPath: binPath,
      rootPath: root,
      env: { ...gitEnv(), ...options.channelEnv },
    },
    options.captureAgentStderr
      ? {
          spawn: (binaryPath, args, spawnOptions) => {
            const child = spawn(binaryPath, args, {
              cwd: spawnOptions.cwd,
              env: spawnOptions.env,
              stdio: ["pipe", "pipe", "pipe"],
            }) as ChildProcessWithoutNullStreams;
            child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
            return child;
          },
        }
      : {},
  );
  const provider = new AgentFsProvider("local", channel);
  const executor = new AgentGitExecutor(provider);
  const repo = new GitRepository(
    "ws-git-streaming",
    root,
    path.join(root, ".git"),
    "git",
    executor,
  );
  try {
    await channel.ready;
    await run({
      root,
      channel,
      provider,
      executor,
      repo,
      agentStderr: () => Buffer.concat(stderrChunks).toString("utf8"),
    });
  } finally {
    channel.dispose();
    provider.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

/**
 * Initializes a deterministic repository without relying on user-global git
 * config or the platform default branch name.
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
 * Writes text inside the temporary repository, creating parent directories for
 * nested path scenarios.
 */
async function writeFile(root: string, relPath: string, content: string): Promise<void> {
  const absolutePath = path.join(root, relPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
}

/**
 * Writes raw bytes inside the temporary repository for blob binary/BOM cases.
 */
async function writeBinaryFile(root: string, relPath: string, content: Buffer): Promise<void> {
  const absolutePath = path.join(root, relPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content);
}

/**
 * Commits all staged and unstaged changes with stable identity and monotonic
 * dates so git log order is deterministic even on fast filesystems.
 */
function commitAll(root: string, subject: string, body?: string): string {
  git(root, ["add", "."]);
  const args = ["commit", "--no-gpg-sign", "-m", subject];
  if (body !== undefined) {
    args.push("-m", body);
  }
  git(root, args);
  return gitStdout(root, ["rev-parse", "HEAD"]).trim();
}

/**
 * Creates a no-fast-forward merge commit with two parents and a first-parent
 * file addition from the merged branch.
 */
async function createMergeCommit(root: string): Promise<string> {
  await writeFile(root, "base.txt", "base\n");
  commitAll(root, "merge base");
  git(root, ["checkout", "-b", "feature"]);
  await writeFile(root, "feature.txt", "feature\n");
  commitAll(root, "feature work");
  git(root, ["checkout", "main"]);
  await writeFile(root, "main.txt", "main\n");
  commitAll(root, "main work");
  git(root, ["merge", "--no-ff", "--no-gpg-sign", "-m", "merge feature branch", "feature"]);
  return gitStdout(root, ["rev-parse", "HEAD"]).trim();
}

/**
 * Runs a git command expected to succeed and throws with stdout/stderr context
 * when fixture setup is not as expected.
 */
function git(root: string, args: readonly string[]): SpawnSyncReturns<Buffer> {
  const result = spawnSync("git", [...args], { cwd: root, env: gitEnvForCommand(args) });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with ${result.status}\nstdout: ${result.stdout.toString()}\nstderr: ${result.stderr.toString()}`,
    );
  }
  return result;
}

/**
 * Returns stdout for a git command that is expected to succeed.
 */
function gitStdout(root: string, args: readonly string[]): string {
  return git(root, args).stdout.toString("utf8");
}

/**
 * Provides a hermetic git environment for both fixture setup and the agent.
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
 * Adds monotonic author/committer dates only for setup commits while
 * preserving the same hermetic git config used by the agent.
 */
function gitEnvForCommand(args: readonly string[]): NodeJS.ProcessEnv {
  const env = gitEnv();
  if (args[0] !== "commit") {
    return env;
  }
  const date = new Date(Date.UTC(2020, 0, 1) + commitSequence * 1_000).toISOString();
  commitSequence += 1;
  return {
    ...env,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
}

/**
 * Drains an async generator while preserving its final return value.
 */
async function drain<T, R>(
  generator: AsyncGenerator<T, R, unknown>,
): Promise<{ chunks: T[]; complete: R }> {
  const chunks: T[] = [];
  for (;;) {
    const next = await generator.next();
    if (next.done) return { chunks, complete: next.value };
    chunks.push(next.value);
  }
}

/**
 * Drains a diff generator and joins all text chunks.
 */
async function drainDiff(
  generator: AsyncGenerator<DiffChunk, DiffComplete, unknown>,
): Promise<{ chunks: DiffChunk[]; text: string; complete: DiffComplete }> {
  const { chunks, complete } = await drain(generator);
  return { chunks, complete, text: chunks.map((chunk) => chunk.text).join("") };
}

/**
 * Alias used when only rejection behavior matters and the complete value is
 * intentionally ignored by the assertion.
 */
async function collect<T, R>(generator: AsyncGenerator<T, R, unknown>): Promise<void> {
  await drain(generator);
}

/**
 * Calls git.blob directly so tests can assert metadata that the higher-level
 * repository byte stream intentionally does not expose.
 */
async function readBlobWire(
  channel: AgentChannel,
  root: string,
  params: {
    readonly ref: string;
    readonly relPath: string;
    readonly maxBytes?: number;
    readonly maxChunkBytes?: number;
  },
): Promise<{
  readonly result: ReturnType<typeof AgentGitBlobResultSchema.parse>;
  readonly chunks: Array<ReturnType<typeof AgentGitBlobChunkPayloadSchema.parse>>;
}> {
  const streamId = `blob-${randomUUID()}`;
  const chunks: Array<ReturnType<typeof AgentGitBlobChunkPayloadSchema.parse>> = [];
  const unsubscribe = channel.on(GIT_BLOB_CHUNK_EVENT, (payload) => {
    const parsed = AgentGitBlobChunkPayloadSchema.safeParse(payload);
    if (parsed.success && parsed.data.streamId === streamId) {
      chunks.push(parsed.data);
    }
  });
  try {
    const result = AgentGitBlobResultSchema.parse(
      await channel.call(GIT_BLOB_METHOD, { cwd: root, streamId, ...params }),
    );
    return { result, chunks };
  } finally {
    unsubscribe();
  }
}

/**
 * Returns an AbortSignal that is already aborted before the semantic method is
 * entered, covering the fast-path consistency contract.
 */
function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

/**
 * Asserts a promise rejects with the platform-neutral AbortError marker.
 */
async function expectAbortError(promise: Promise<unknown>, label: string): Promise<void> {
  try {
    await promise;
    throw new Error(`${label} resolved unexpectedly`);
  } catch (error) {
    expect((error as Error).name).toBe("AbortError");
  }
}

/**
 * Starts a stream, waits for at least one chunk, aborts, then drains until the
 * queued stream surfaces AbortError.
 */
async function expectActiveStreamAbort<T, R>(
  create: (signal: AbortSignal) => AsyncGenerator<T, R, unknown>,
  assertFirst: (chunk: T) => void,
  label: string,
): Promise<void> {
  const controller = new AbortController();
  const generator = create(controller.signal);
  const first = await withTimeout(generator.next(), RUN_TIMEOUT_MS, `${label} first chunk`);
  if (first.done) throw new Error(`${label} completed before first chunk`);
  assertFirst(first.value);
  controller.abort();
  for (let i = 0; i < 100; i++) {
    try {
      const next = await withTimeout(generator.next(), RUN_TIMEOUT_MS, `${label} abort drain`);
      if (next.done) {
        throw new Error(`${label} completed without AbortError`);
      }
    } catch (error) {
      expect((error as Error).name).toBe("AbortError");
      return;
    }
  }
  throw new Error(`${label} yielded 100 chunks after abort without AbortError`);
}

/**
 * Bounds asynchronous integration assertions so a failed process kill shows up
 * as a test failure instead of hanging the suite.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Installs a deterministic fake git command used only for active-cancel
 * probing. It keeps the real agent/bridge path while avoiding timing races
 * with fast local repositories.
 */
async function writeSlowFakeGit(fakeGitDir: string): Promise<void> {
  const script = `#!/bin/sh
cmd="$1"
if [ "$cmd" = "log" ]; then
  i=0
  while :; do
    sha=$(printf "%040d" "$i")
    short=$(printf "%07d" "$i")
    printf "%s\\037%s\\037\\037Nexus Test\\037nexus-test@example.invalid\\0372020-01-01T00:00:00Z\\037slow log %s\\037\\037\\036" "$sha" "$short" "$i"
    i=$((i + 1))
    sleep 0.005
  done
fi
if [ "$cmd" = "diff" ]; then
  i=0
  while :; do
    printf "+slow diff %06d 🙂\\n" "$i"
    i=$((i + 1))
    sleep 0.005
  done
fi
if [ "$cmd" = "cat-file" ]; then
  read _spec
  printf "deadbeef blob 1000000\\n"
  while :; do
    printf "0123456789abcdef"
    sleep 0.005
  done
fi
exit 0
`;
  const gitPath = path.join(fakeGitDir, "git");
  await fs.writeFile(gitPath, script, "utf8");
  await fs.chmod(gitPath, 0o755);
}
