/** A workspace's files searched from another device: by name, and for text, in its agent. */
import { describe, expect, test } from "bun:test";
import type { FsProvider } from "../../../../../src/main/features/fs/bridge/provider";
import { findFiles, searchFiles } from "../../../../../src/main/features/remote/search";
import type { FileMatch } from "../../../../../src/shared/search/types";

interface Call {
  method: string;
  params: Record<string, unknown>;
}

/**
 * An agent that answers search.files with `found`, and search.text by
 * sending `batches` as progress then answering, or never answering when
 * `hang`.
 */
function fakeAgent(
  options: {
    found?: { files: string[]; truncated: boolean } | Error;
    batches?: FileMatch[][];
    hang?: boolean;
    fail?: Error;
  } = {},
): { fs: FsProvider; calls: Call[] } {
  const calls: Call[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const emit = (event: string, payload: unknown) => {
    for (const l of listeners.get(event) ?? []) l(payload);
  };
  const fs = {
    kind: "ssh",
    onAgentLifecycle: () => () => {},
    onAgentEvent: (event: string, callback: (payload: unknown) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(callback);
      listeners.set(event, set);
      return () => set.delete(callback);
    },
    callAgentMethod: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "search.files") {
        if (options.found instanceof Error) throw options.found;
        return options.found ?? { files: [], truncated: false };
      }
      if (method === "search.cancel") return {};
      if (options.fail) throw options.fail;
      const searchId = params.searchId as string;
      // Another search's progress is not this one's.
      emit("search.progress", {
        searchId: "other",
        batch: [{ relPath: "other.ts", matches: [] }],
      });
      for (const batch of options.batches ?? []) {
        await Promise.resolve();
        emit("search.progress", { searchId, batch });
      }
      if (options.hang) return new Promise(() => {});
      const matchesFound = (options.batches ?? []).flat().reduce((n, f) => n + f.matches.length, 0);
      return { filesScanned: 3, matchesFound, limitHit: false, elapsedMs: 1 };
    },
  } as unknown as FsProvider;
  return { fs, calls };
}

const match = (
  line: number,
  startCol: number,
  endCol: number,
  preview: string,
  previewStart?: number,
) => ({
  range: { line, startCol, endCol },
  preview,
  ...(previewStart !== undefined ? { previewStart } : {}),
});

describe("finding files by name", () => {
  test("asks the agent, the best first, so many", async () => {
    const { fs, calls } = fakeAgent({ found: { files: ["src/a.ts", "b/a.ts"], truncated: false } });
    expect(await findFiles(fs, { workspaceId: "w1", query: "a.ts" })).toEqual({
      files: ["src/a.ts", "b/a.ts"],
    });
    await findFiles(fs, { workspaceId: "w1", query: "x", limit: 7 });
    expect(calls).toEqual([
      { method: "search.files", params: { query: "a.ts", limit: 50 } },
      { method: "search.files", params: { query: "x", limit: 7 } },
    ]);
  });

  test("says when the workspace has more files than were looked through, or a frame takes", async () => {
    const walked = fakeAgent({ found: { files: ["a"], truncated: true } });
    expect(await findFiles(walked.fs, { workspaceId: "w1", query: "a" })).toEqual({
      files: ["a"],
      truncated: true,
    });
    const long = fakeAgent({
      found: {
        files: Array.from({ length: 200 }, (_, i) => `${"d/".repeat(2000)}${i}`),
        truncated: false,
      },
    });
    const cut = await findFiles(long.fs, { workspaceId: "w1", query: "a", limit: 200 });
    expect(cut.truncated).toBe(true);
    expect(cut.files.length).toBeLessThan(200);
  });

  test("Unavailable without the agent, or with one that cannot", async () => {
    const plain = { kind: "local" } as unknown as FsProvider;
    await expect(findFiles(plain, { workspaceId: "w1", query: "a" })).rejects.toMatchObject({
      code: 1003,
    });
    const old = fakeAgent({ found: new Error("method not found: search.files") });
    await expect(findFiles(old.fs, { workspaceId: "w1", query: "a" })).rejects.toMatchObject({
      code: 1003,
    });
  });
});

describe("searching files for text", () => {
  test("as the search panel asks, its matches from line 1", async () => {
    const { fs, calls } = fakeAgent({
      batches: [
        [{ relPath: "src/a.ts", matches: [match(0, 6, 9, "const foo = 1")] }],
        [{ relPath: "min.js", matches: [match(4, 900, 903, "…foo…", 860)] }],
      ],
    });
    const found = await searchFiles(fs, {
      workspaceId: "w1",
      query: "foo",
      regex: true,
      wholeWord: true,
      include: ["*.ts"],
      exclude: ["dist/"],
    });
    expect(found).toEqual({
      files: [
        { path: "src/a.ts", matches: [{ line: 1, column: 6, length: 3, text: "const foo = 1" }] },
        {
          path: "min.js",
          matches: [{ line: 5, column: 900, length: 3, text: "…foo…", textStart: 860 }],
        },
      ],
    });
    expect(calls[0]?.params.query).toEqual({
      pattern: "foo",
      isRegExp: true,
      isCaseSensitive: false,
      isWordMatch: true,
      includes: ["*.ts"],
      excludes: ["dist/"],
      maxResults: 201,
      maxFileSize: expect.any(Number),
    });
    // Answered: nothing left to cancel.
    expect(calls.map((c) => c.method)).toEqual(["search.text"]);
  });

  test("so many matches, the rest left out, and the search there stopped", async () => {
    const three = [match(0, 0, 1, "a"), match(1, 0, 1, "a"), match(2, 0, 1, "a")];
    const { fs, calls } = fakeAgent({
      batches: [[{ relPath: "x", matches: three }], [{ relPath: "y", matches: three }]],
      hang: true,
    });
    const found = await searchFiles(fs, { workspaceId: "w1", query: "a", limit: 4 });
    expect(found.truncated).toBe(true);
    expect(found.files.map((f) => [f.path, f.matches.length])).toEqual([
      ["x", 3],
      ["y", 1],
    ]);
    expect(calls.map((c) => c.method)).toEqual(["search.text", "search.cancel"]);
  });

  test("out of time: what it found so far, cut", async () => {
    const { fs, calls } = fakeAgent({
      batches: [[{ relPath: "x", matches: [match(0, 0, 1, "a")] }]],
      hang: true,
    });
    const found = await searchFiles(fs, { workspaceId: "w1", query: "a" }, 20);
    expect(found).toEqual({
      files: [{ path: "x", matches: [{ line: 1, column: 0, length: 1, text: "a" }] }],
      truncated: true,
    });
    expect(calls.at(-1)?.method).toBe("search.cancel");
  });

  test("a pattern that is no regular expression is the asker's error", async () => {
    const { fs } = fakeAgent({ fail: new Error('Invalid search pattern "(": missing )') });
    await expect(
      searchFiles(fs, { workspaceId: "w1", query: "(", regex: true }),
    ).rejects.toMatchObject({ code: -32602 });
    const broken = fakeAgent({ fail: new Error("agent gone") });
    await expect(searchFiles(broken.fs, { workspaceId: "w1", query: "a" })).rejects.toMatchObject({
      code: 1003,
    });
  });
});
