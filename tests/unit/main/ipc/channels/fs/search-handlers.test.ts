import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  searchTextStream,
  WorkspaceNotFoundError,
} from "../../../../../../src/main/ipc/channels/fs/search-handlers";
import type { StreamContext } from "../../../../../../src/main/ipc/router";
import { InvalidSearchPatternError } from "../../../../../../src/main/search/matcher";
import type {
  FileMatch,
  SearchComplete,
  TextSearchQuery,
} from "../../../../../../src/shared/types/search";
import type { WorkspaceMeta } from "../../../../../../src/shared/types/workspace";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174001";
const UNKNOWN_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

function baseQuery(overrides: Partial<TextSearchQuery> & { pattern: string }): TextSearchQuery {
  return {
    isRegExp: false,
    isCaseSensitive: false,
    isWordMatch: false,
    includes: [],
    excludes: [],
    maxResults: 2000,
    maxFileSize: 5 * 1024 * 1024,
    ...overrides,
  };
}

function makeManager(rootPath: string, workspaces: WorkspaceMeta[] = [makeWorkspace(rootPath)]) {
  return {
    list: (): WorkspaceMeta[] => workspaces,
  };
}

function makeWorkspace(rootPath: string, id = VALID_UUID): WorkspaceMeta {
  return {
    id,
    name: "test-workspace",
    rootPath,
    location: { kind: "local", rootPath },
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date().toISOString(),
    tabs: [],
  };
}

function context(signal: AbortSignal = new AbortController().signal): StreamContext {
  return { signal };
}

async function consumeSearch(
  generator: AsyncGenerator<FileMatch[], SearchComplete, unknown>,
): Promise<{ progress: FileMatch[][]; complete: SearchComplete }> {
  const progress: FileMatch[][] = [];

  while (true) {
    const next = await generator.next();
    if (next.done) {
      return { progress, complete: next.value };
    }
    progress.push(next.value);
  }
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-search-handler-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("searchTextStream", () => {
  test("returns an empty completion and yields no progress when there are no matches", async () => {
    fs.writeFileSync(path.join(tmpRoot, "readme.md"), "No matching text here.\n");

    const handler = searchTextStream(makeManager(tmpRoot) as never);
    const { progress, complete } = await consumeSearch(
      handler({ workspaceId: VALID_UUID, query: baseQuery({ pattern: "needle" }) }, context()),
    );

    expect(progress).toEqual([]);
    expect(complete.filesScanned).toBe(1);
    expect(complete.matchesFound).toBe(0);
    expect(complete.limitHit).toBe(false);
    expect(complete.elapsedMs).toEqual(expect.any(Number));
  });

  test("yields FileMatch[] batches and returns final search counts", async () => {
    for (let i = 0; i < 60; i++) {
      fs.writeFileSync(path.join(tmpRoot, `file-${i}.ts`), "needle\n");
    }

    const handler = searchTextStream(makeManager(tmpRoot) as never);
    const { progress, complete } = await consumeSearch(
      handler({ workspaceId: VALID_UUID, query: baseQuery({ pattern: "needle" }) }, context()),
    );

    const allMatches = progress.flat();
    const totalMatches = allMatches.reduce((sum, file) => sum + file.matches.length, 0);

    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(allMatches).toHaveLength(60);
    expect(totalMatches).toBe(60);
    expect(complete.filesScanned).toBe(60);
    expect(complete.matchesFound).toBe(60);
    expect(complete.limitHit).toBe(false);
    expect(complete.elapsedMs).toEqual(expect.any(Number));
  });

  test("throws AbortError when the stream signal is already aborted", async () => {
    fs.writeFileSync(path.join(tmpRoot, "a.ts"), "needle\n");
    const ctrl = new AbortController();
    ctrl.abort();

    const handler = searchTextStream(makeManager(tmpRoot) as never);
    const generator = handler(
      { workspaceId: VALID_UUID, query: baseQuery({ pattern: "needle" }) },
      context(ctrl.signal),
    );

    await expect(generator.next()).rejects.toThrow("aborted");
  });

  test("throws InvalidSearchPatternError for an invalid regex", async () => {
    const handler = searchTextStream(makeManager(tmpRoot) as never);
    const generator = handler(
      {
        workspaceId: VALID_UUID,
        query: baseQuery({ pattern: "[invalid", isRegExp: true }),
      },
      context(),
    );

    await expect(generator.next()).rejects.toBeInstanceOf(InvalidSearchPatternError);
  });

  test("throws WorkspaceNotFoundError for an unknown workspace", async () => {
    const handler = searchTextStream(makeManager(tmpRoot) as never);
    const generator = handler(
      { workspaceId: UNKNOWN_UUID, query: baseQuery({ pattern: "needle" }) },
      context(),
    );

    const err = await generator.next().catch((error: unknown) => error);
    expect(err).toBeInstanceOf(WorkspaceNotFoundError);
    expect((err as WorkspaceNotFoundError).name).toBe("WorkspaceNotFoundError");
    expect((err as WorkspaceNotFoundError).workspaceId).toBe(UNKNOWN_UUID);
  });
});
