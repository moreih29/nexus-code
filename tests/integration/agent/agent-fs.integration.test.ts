/**
 * Round-trip test for the agent NDJSON channel.
 *
 * The purpose is drift detection between the TS protocol schemas
 * (`src/shared/protocol/agent/*.ts`) and the Go implementation
 * (`internal/fs/*.go`). The test spawns the real agent binary via
 * the production `createLocalChannel` factory — so any regression in that
 * factory also surfaces here. The main response paths are exercised on the same
 * channel so the envelope's result/error variants both round-trip cleanly:
 *   1. Ready frame on boot
 *   2. Success result variant (kind="ok")
 *   3. Conflict result variant (kind="conflict")
 *   4. Server error frame (code=OUT_OF_WORKSPACE)
 *
 * The Go agent handles each request on its own goroutine, so response order
 * is not guaranteed to match request order. The channel's pipe demultiplexes
 * by `id` internally; this test just awaits N promises in parallel.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { createLocalChannel } from "../../../src/main/agent/local-channel";
import { AGENT_PROTOCOL_VERSION } from "../../../src/shared/protocol/agent/envelope";
import { AgentFsErrorCodeSchema } from "../../../src/shared/protocol/agent/errors";
import {
  FS_RENAME_METHOD,
  FS_RMDIR_METHOD,
  FS_UNLINK_METHOD,
  FsReadAbsoluteResultSchema,
  type FsWriteFileParams,
  FsWriteFileResultSchema,
} from "../../../src/shared/protocol/agent/fs";
import {
  AgentGitChangedPayloadSchema,
  AgentGitGetFileContentResultSchema,
  AgentGitMetadataResultSchema,
  AgentGitRunResultSchema,
  AgentGitStreamChunkPayloadSchema,
  GIT_CHANGED_EVENT,
  GIT_GET_FILE_CONTENT_METHOD,
  GIT_METADATA_METHOD,
  GIT_RUN_METHOD,
  GIT_STREAM_CHUNK_EVENT,
  GIT_STREAM_METHOD,
  GIT_UNWATCH_METHOD,
  GIT_WATCH_METHOD,
} from "../../../src/shared/protocol/agent/git";
import {
  AgentSearchCompleteSchema,
  AgentSearchProgressPayloadSchema,
  SEARCH_PROGRESS_EVENT,
  SEARCH_TEXT_METHOD,
} from "../../../src/shared/protocol/agent/search";
import { FsChangeSchema, type FsChange } from "../../../src/shared/types/fs";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const AgentFsChangedPayloadSchema = z.object({ changes: z.array(FsChangeSchema) });

const goAvailable = spawnSync("go", ["version"]).status === 0;
const gitAvailable = spawnSync("git", ["--version"]).status === 0;

describe("agent fs round-trip", () => {
  if (!goAvailable) {
    it("skips when go is unavailable", () => {});
    return;
  }

  let binPath: string;
  let buildDir: string;

  beforeAll(async () => {
    buildDir = await fs.mkdtemp(path.join(tmpdir(), "agent-build-"));
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
  });

  it("emits ready, then ok / conflict / error responses that match the TS schemas", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "agent-root-"));
    const channel = createLocalChannel({ binaryPath: binPath, rootPath: root });

    try {
      // 1. Ready frame — channel.ready resolves once the server emits it.
      // The channel parses the boot frame internally; the protocol-version
      // check happens inside the pipe and would surface as a ready rejection.
      await channel.ready;

      // 2. Ok variant — first write of a new file.
      const okParams: FsWriteFileParams = {
        relPath: "hello.txt",
        content: "world",
        expected: { exists: false },
      };
      const okResult = FsWriteFileResultSchema.parse(await channel.call("fs.writeFile", okParams));
      expect(okResult.kind).toBe("ok");
      const written = await fs.readFile(path.join(root, "hello.txt"), "utf8");
      expect(written).toBe("world");

      await channel.call("fs.createFile", { relPath: "empty.txt" });
      await expect(fs.readFile(path.join(root, "empty.txt"), "utf8")).resolves.toBe("");

      await channel.call("fs.mkdir", { relPath: "src" });
      const srcStat = await fs.stat(path.join(root, "src"));
      expect(srcStat.isDirectory()).toBe(true);

      const searchProgress: unknown[] = [];
      const unsubscribeSearch = channel.on(SEARCH_PROGRESS_EVENT, (payload) => {
        searchProgress.push(payload);
      });
      const searchComplete = AgentSearchCompleteSchema.parse(
        await channel.call(SEARCH_TEXT_METHOD, {
          searchId: "search-1",
          query: {
            pattern: "world",
            isRegExp: false,
            isCaseSensitive: false,
            isWordMatch: false,
            includes: [],
            excludes: [],
            maxResults: 2000,
            maxFileSize: 5 * 1024 * 1024,
          },
        }),
      );
      unsubscribeSearch();
      const searchBatches = searchProgress.map((payload) =>
        AgentSearchProgressPayloadSchema.parse(payload),
      );
      expect(searchComplete.matchesFound).toBe(1);
      expect(searchBatches.flatMap((payload) => payload.batch).map((file) => file.relPath)).toEqual([
        "hello.txt",
      ]);

      if (gitAvailable) {
        expect(spawnSync("git", ["init"], { cwd: root }).status).toBe(0);
        expect(spawnSync("git", ["add", "hello.txt"], { cwd: root }).status).toBe(0);
        const gitRun = AgentGitRunResultSchema.parse(
          await channel.call(GIT_RUN_METHOD, {
            cwd: root,
            args: ["status", "--porcelain=v1"],
          }),
        );
        expect(gitRun.code).toBe(0);
        expect(gitRun.stdout).toContain("A  hello.txt");

        const gitStreamPayloads: unknown[] = [];
        const unsubscribeGitStream = channel.on(GIT_STREAM_CHUNK_EVENT, (payload) => {
          gitStreamPayloads.push(payload);
        });
        const gitStreamComplete = AgentGitRunResultSchema.parse(
          await channel.call(GIT_STREAM_METHOD, {
            streamId: "git-stream-1",
            cwd: root,
            args: ["show", ":hello.txt"],
          }),
        );
        unsubscribeGitStream();
        expect(gitStreamComplete.code).toBe(0);
        const gitStreamText = gitStreamPayloads
          .map((payload) => AgentGitStreamChunkPayloadSchema.parse(payload))
          .filter((payload) => payload.streamId === "git-stream-1")
          .map((payload) => Buffer.from(payload.chunk, "base64").toString("utf8"))
          .join("");
        expect(gitStreamText).toBe("world");

        const gitMetadata = AgentGitMetadataResultSchema.parse(
          await channel.call(GIT_METADATA_METHOD, {
            gitDir: path.join(root, ".git"),
            conflictCount: 0,
          }),
        );
        expect(gitMetadata.operationState).toEqual({ kind: "none" });
        expect(gitMetadata.lastFetchedAt).toBeNull();

        const gitChanged = waitForAgentEvent(channel, GIT_CHANGED_EVENT);
        await channel.call(GIT_WATCH_METHOD, { gitDir: path.join(root, ".git") });
        await fs.writeFile(path.join(root, ".git", "NEXUS_TEST_MARKER"), "change");
        const gitChangedPayload = AgentGitChangedPayloadSchema.parse(await gitChanged);
        expect(gitChangedPayload.gitDir).toBe(path.join(root, ".git"));
        await channel.call(GIT_UNWATCH_METHOD, { gitDir: path.join(root, ".git") });

        const gitContent = AgentGitGetFileContentResultSchema.parse(
          await channel.call(GIT_GET_FILE_CONTENT_METHOD, {
            ref: "INDEX",
            relPath: "hello.txt",
          }),
        );
        expect(gitContent.kind).toBe("ok");
        if (gitContent.kind === "ok") {
          expect(gitContent.content).toBe("world");
        }
      }

      const changed = waitForAgentEvent(channel, "fs.changed");
      await channel.call("fs.watch", { relPath: "." });
      await fs.writeFile(path.join(root, "watched.txt"), "change");
      const changedPayload = (await changed) as { changes?: Array<{ relPath: string }> };
      expect(changedPayload.changes?.some((change) => change.relPath === "watched.txt")).toBe(true);
      await channel.call("fs.unwatch", { relPath: "." });

      const externalPath = path.join(await fs.mkdtemp(path.join(tmpdir(), "agent-external-")), "lib.ts");
      await fs.writeFile(externalPath, "external");
      const externalResult = FsReadAbsoluteResultSchema.parse(
        await channel.call("fs.readAbsolute", { absolutePath: externalPath }),
      );
      expect(externalResult.kind).toBe("ok");
      if (externalResult.kind === "ok") {
        expect(externalResult.content).toBe("external");
      }

      // 3. Conflict variant — expected:false but the file now exists. The
      // server returns this as a success-shaped frame (channel resolves) with
      // a discriminated `kind: "conflict"` payload, not as an error frame.
      const conflictResult = FsWriteFileResultSchema.parse(
        await channel.call("fs.writeFile", {
          relPath: "hello.txt",
          content: "v2",
          expected: { exists: false },
        }),
      );
      expect(conflictResult.kind).toBe("conflict");
      if (conflictResult.kind === "conflict") {
        expect(conflictResult.actual.exists).toBe(true);
      }

      // 4. Error frame — path escape rejected by Resolve. The channel rejects
      // the call with an Error whose `code` is the server's wire code.
      const errorCode = await callExpectErrorCode(channel, "fs.writeFile", {
        relPath: "../escape.txt",
        content: "x",
      });
      expect(AgentFsErrorCodeSchema.parse(errorCode)).toBe("OUT_OF_WORKSPACE");

      // Sanity: protocol version constant is what the integration test
      // expects today. If the Go side bumps it without TS following, the
      // ready handshake would have already failed before we got here.
      expect(AGENT_PROTOCOL_VERSION).toBe("1");
    } finally {
      channel.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("round-trips unlink, rmdir, and rename through the real agent channel", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "agent-root-"));
    const channel = createLocalChannel({ binaryPath: binPath, rootPath: root });

    try {
      await channel.ready;

      const unlinkTarget = "delete-me.txt";
      const unlinkDir = "unlink-refuses-dir";
      const emptyDir = "empty-dir";
      const nonEmptyDir = "non-empty-dir";
      const renameSource = "rename-source.txt";
      const renameTarget = "rename-target.txt";
      const renameConflictSource = "rename-conflict-source.txt";
      const renameConflictTarget = "rename-conflict-target.txt";

      await fs.writeFile(path.join(root, unlinkTarget), "remove me");
      await fs.mkdir(path.join(root, unlinkDir));
      await fs.mkdir(path.join(root, emptyDir));
      await fs.mkdir(path.join(root, nonEmptyDir));
      await fs.writeFile(path.join(root, nonEmptyDir, "child.txt"), "child");
      await fs.writeFile(path.join(root, renameSource), "move me");
      await fs.writeFile(path.join(root, renameConflictSource), "source");
      await fs.writeFile(path.join(root, renameConflictTarget), "target");

      await channel.call("fs.watch", { relPath: "." });
      try {
        const unlinkChanged = waitForFsChange(
          channel,
          `${unlinkTarget} deleted`,
          (changes) => hasFsChange(changes, unlinkTarget, "deleted"),
        );
        expect(await channel.call(FS_UNLINK_METHOD, { relPath: unlinkTarget })).toEqual({});
        expect(await unlinkChanged).toContainEqual({ relPath: unlinkTarget, kind: "deleted" });
        await expect(fs.stat(path.join(root, unlinkTarget))).rejects.toMatchObject({
          code: "ENOENT",
        });

        const unlinkDirCode = await callExpectErrorCode(channel, FS_UNLINK_METHOD, {
          relPath: unlinkDir,
        });
        expect(AgentFsErrorCodeSchema.parse(unlinkDirCode)).toBe("IS_DIRECTORY");

        const rmdirChanged = waitForFsChange(
          channel,
          `${emptyDir} deleted`,
          (changes) => hasFsChange(changes, emptyDir, "deleted"),
        );
        expect(await channel.call(FS_RMDIR_METHOD, { relPath: emptyDir })).toEqual({});
        expect(await rmdirChanged).toContainEqual({ relPath: emptyDir, kind: "deleted" });
        await expect(fs.stat(path.join(root, emptyDir))).rejects.toMatchObject({ code: "ENOENT" });

        const rmdirCode = await callExpectErrorCode(channel, FS_RMDIR_METHOD, {
          relPath: nonEmptyDir,
        });
        expect(AgentFsErrorCodeSchema.parse(rmdirCode)).toBe("NOT_EMPTY");

        const renameChanged = waitForFsChange(
          channel,
          `${renameSource} deleted or ${renameTarget} added`,
          (changes) =>
            hasFsChange(changes, renameSource, "deleted") ||
            hasFsChange(changes, renameTarget, "added"),
        );
        expect(
          await channel.call(FS_RENAME_METHOD, {
            fromRelPath: renameSource,
            toRelPath: renameTarget,
          }),
        ).toEqual({});
        const renameChanges = await renameChanged;
        expect(
          hasFsChange(renameChanges, renameSource, "deleted") ||
            hasFsChange(renameChanges, renameTarget, "added"),
        ).toBe(true);
        await expect(fs.stat(path.join(root, renameSource))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(fs.readFile(path.join(root, renameTarget), "utf8")).resolves.toBe("move me");

        const renameCode = await callExpectErrorCode(channel, FS_RENAME_METHOD, {
          fromRelPath: renameConflictSource,
          toRelPath: renameConflictTarget,
        });
        expect(AgentFsErrorCodeSchema.parse(renameCode)).toBe("ALREADY_EXISTS");
      } finally {
        await channel.call("fs.unwatch", { relPath: "." }).catch(() => {});
      }
    } finally {
      channel.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

function waitForAgentEvent(
  channel: ReturnType<typeof createLocalChannel>,
  event: string,
  timeoutMs = 2_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const unsubscribe = channel.on(event, (payload) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(payload);
    });
  });
}

/**
 * Waits for fs.changed batches until one satisfies the caller's predicate.
 * This keeps watcher assertions event-driven instead of sleeping around the
 * agent's fsnotify debounce window.
 */
function waitForFsChange(
  channel: ReturnType<typeof createLocalChannel>,
  label: string,
  predicate: (changes: readonly FsChange[]) => boolean,
  timeoutMs = 3_000,
): Promise<FsChange[]> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for fs.changed: ${label}`));
    }, timeoutMs);

    unsubscribe = channel.on("fs.changed", (payload) => {
      let changes: FsChange[];
      try {
        changes = AgentFsChangedPayloadSchema.parse(payload).changes;
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (!predicate(changes)) return;
      cleanup();
      resolve(changes);
    });
  });
}

/** Returns whether a watcher batch contains the expected path/kind pair. */
function hasFsChange(
  changes: readonly FsChange[],
  relPath: string,
  kind: FsChange["kind"],
): boolean {
  return changes.some((change) => change.relPath === relPath && change.kind === kind);
}

/**
 * Wraps `channel.call` to assert the rejection path and surface the wire
 * `code` attached to the thrown Error. The pipe attaches `code` whenever the
 * server frame carries a string `code`, which the Go side always does.
 */
async function callExpectErrorCode(
  channel: ReturnType<typeof createLocalChannel>,
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
