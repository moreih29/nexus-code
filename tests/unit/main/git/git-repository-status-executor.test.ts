import { describe, expect, mock, test } from "bun:test";
import type { AgentBackedProvider } from "../../../../src/main/features/fs/bridge/provider";
import { AgentGitExecutor } from "../../../../src/main/features/git/bridge/agent-executor";
import {
  GIT_BLOB_CHUNK_EVENT,
  GIT_BLOB_METHOD,
  GIT_CANCEL_METHOD,
  GIT_DIFF_CHUNK_EVENT,
  GIT_DIFF_METHOD,
  GIT_LOG_BATCH_EVENT,
  GIT_LOG_METHOD,
  GIT_STATUS_METHOD,
  GIT_STREAM_CHUNK_EVENT,
  GIT_STREAM_METHOD,
} from "../../../../src/shared/git/protocol";
import {
  DEFAULT_GIT_OPERATION_STATE,
  DEFAULT_REPO_CAPABILITIES,
  type GitStatus,
} from "../../../../src/shared/git/types";

describe("AgentGitExecutor.status", () => {
  test("calls git.status and validates the GitStatus result schema", async () => {
    const expected = cleanStatus({
      branch: {
        current: "main",
        upstream: null,
        ahead: 0,
        behind: 0,
        isUnborn: false,
      },
    });
    const callAgentMethod = mock(async (method: string, params?: unknown) => {
      expect(method).toBe(GIT_STATUS_METHOD);
      expect(params).toEqual({
        cwd: "/repo",
        untracked: "normal",
        renames: false,
        ignored: true,
      });
      return expected;
    });
    const executor = new AgentGitExecutor(fakeProvider(callAgentMethod));

    const actual = await executor.status({
      cwd: "/repo",
      untracked: "normal",
      renames: false,
      ignored: true,
    });

    expect(actual).toEqual(expected);
    expect(callAgentMethod).toHaveBeenCalledTimes(1);
  });
});

describe("AgentGitExecutor semantic streams", () => {
  test("stream forwards streamStderr and filters stream chunks by streamId", async () => {
    const provider = streamingProvider(async (method, params, emit) => {
      if (method === GIT_CANCEL_METHOD) return {};
      expect(method).toBe(GIT_STREAM_METHOD);
      const streamId = readStreamId(params);
      expect(params).toMatchObject({
        cwd: "/repo",
        args: ["clone", "--progress"],
        interactive: true,
        streamStderr: true,
      });
      emit(GIT_STREAM_CHUNK_EVENT, {
        streamId: "other",
        chunk: Buffer.from("wrong").toString("base64"),
      });
      emit(GIT_STREAM_CHUNK_EVENT, {
        streamId,
        chunk: Buffer.from("Receiving objects: 100% (1/1)\n").toString("base64"),
      });
      return { stdout: "", stderr: "", code: 0 };
    });
    const executor = new AgentGitExecutor(provider);

    const actual = await drain(
      executor.stream({
        bin: "git",
        cwd: "/repo",
        args: ["clone", "--progress"],
        interactive: true,
        streamStderr: true,
      }),
    );

    expect(actual.chunks.map((chunk) => chunk.toString("utf8"))).toEqual([
      "Receiving objects: 100% (1/1)\n",
    ]);
  });

  test("log calls git.log and filters batch events by streamId", async () => {
    const provider = streamingProvider(async (method, params, emit) => {
      if (method === GIT_CANCEL_METHOD) return {};
      expect(method).toBe(GIT_LOG_METHOD);
      const streamId = readStreamId(params);
      expect(params).toMatchObject({ cwd: "/repo", scope: "ref", skip: 3, limit: 1 });
      emit(GIT_LOG_BATCH_EVENT, { streamId: "other", entries: [logEntry("wrong")] });
      emit(GIT_LOG_BATCH_EVENT, { streamId, entries: [logEntry("right")] });
      return { count: 1, hasMore: false, totalScanned: 2 };
    });
    const executor = new AgentGitExecutor(provider);

    const actual = await drain(executor.log({ cwd: "/repo", scope: "ref", skip: 3, limit: 1 }));

    expect(actual.chunks.map((chunk) => chunk.entries.map((entry) => entry.sha))).toEqual([
      ["right"],
    ]);
    expect(actual.complete).toEqual({ count: 1, hasMore: false, totalScanned: 2 });
  });

  test("diff calls git.diff and filters chunk events by streamId", async () => {
    const provider = streamingProvider(async (method, params, emit) => {
      if (method === GIT_CANCEL_METHOD) return {};
      expect(method).toBe(GIT_DIFF_METHOD);
      const streamId = readStreamId(params);
      expect(params).toMatchObject({ cwd: "/repo", cached: true });
      emit(GIT_DIFF_CHUNK_EVENT, { streamId: "other", text: "wrong" });
      emit(GIT_DIFF_CHUNK_EVENT, { streamId, text: "right" });
      return { bytes: 5, truncated: false };
    });
    const executor = new AgentGitExecutor(provider);

    const actual = await drain(executor.diff({ cwd: "/repo", spec: { kind: "index-vs-head" } }));

    expect(actual.chunks).toEqual([{ text: "right" }]);
    expect(actual.complete).toEqual({ bytes: 5, truncated: false });
  });

  test("blob calls git.blob, filters chunk events by streamId, and decodes bytes", async () => {
    const provider = streamingProvider(async (method, params, emit) => {
      if (method === GIT_CANCEL_METHOD) return {};
      expect(method).toBe(GIT_BLOB_METHOD);
      const streamId = readStreamId(params);
      emit(GIT_BLOB_CHUNK_EVENT, {
        streamId: "other",
        chunk: Buffer.from("bad").toString("base64"),
      });
      emit(GIT_BLOB_CHUNK_EVENT, { streamId, chunk: Buffer.from("ok").toString("base64") });
      return {
        size: 2,
        isBinary: false,
        encoding: "utf8",
        mtime: null,
        truncated: false,
      };
    });
    const executor = new AgentGitExecutor(provider);

    const actual = await drain(executor.blob({ cwd: "/repo", ref: "HEAD", relPath: "README.md" }));

    expect(actual.chunks.map((chunk) => Buffer.from(chunk.chunk).toString("utf8"))).toEqual(["ok"]);
    expect(actual.complete).toEqual({ bytes: 2 });
  });
});

/** Builds a schema-valid status snapshot and allows each test to vary the signal fields. */
function cleanStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    merge: [],
    staged: [],
    working: [],
    untracked: [],
    branch: null,
    capabilities: { ...DEFAULT_REPO_CAPABILITIES },
    operationState: DEFAULT_GIT_OPERATION_STATE,
    lastFetchedAt: null,
    ...overrides,
  };
}

/** Drains an async generator while preserving its final return value. */
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

/** Minimal log entry for semantic stream tests. */
function logEntry(sha: string) {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    parents: [],
    authorName: "A User",
    authorEmail: "a@example.test",
    authoredAt: "2026-05-13T00:00:00Z",
    subject: `subject ${sha}`,
    refs: [],
  };
}

function readStreamId(params: unknown): string {
  if (
    typeof params !== "object" ||
    params === null ||
    typeof (params as { streamId?: unknown }).streamId !== "string"
  ) {
    throw new Error("expected params.streamId");
  }
  return (params as { streamId: string }).streamId;
}

type EmitAgentEvent = (event: string, payload: unknown) => void;

/** Creates the minimal agent-backed provider surface needed by AgentGitExecutor.status. */
function fakeProvider(
  callAgentMethod: (method: string, params?: unknown) => Promise<unknown>,
): AgentBackedProvider {
  const fail = async (): Promise<never> => {
    throw new Error("unexpected filesystem provider call");
  };
  return {
    kind: "local",
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
    callAgentMethod,
    onAgentEvent: () => () => {},
    onAgentLifecycle: () => () => {},
  } as AgentBackedProvider;
}

function streamingProvider(
  callAgentMethod: (method: string, params: unknown, emit: EmitAgentEvent) => Promise<unknown>,
): AgentBackedProvider {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const emit: EmitAgentEvent = (event, payload) => {
    for (const handler of handlers.get(event) ?? []) handler(payload);
  };
  const provider = fakeProvider((method, params) => callAgentMethod(method, params, emit));
  provider.onAgentEvent = (event, handler) => {
    const set = handlers.get(event) ?? new Set<(payload: unknown) => void>();
    set.add(handler);
    handlers.set(event, set);
    return () => set.delete(handler);
  };
  return provider;
}
