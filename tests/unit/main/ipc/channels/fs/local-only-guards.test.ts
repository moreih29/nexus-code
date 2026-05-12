import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchTextStream } from "../../../../../../src/main/ipc/channels/fs/search-handlers";
import {
  unwatchHandler,
  watchHandler,
} from "../../../../../../src/main/ipc/channels/fs/watch-handlers";
import { writeFileHandler } from "../../../../../../src/main/ipc/channels/fs/write-handlers";
import type { StreamContext } from "../../../../../../src/main/ipc/router";
import { UnsupportedSshWorkspaceError } from "../../../../../../src/main/workspace/workspace-guards";
import type { TextSearchQuery } from "../../../../../../src/shared/types/search";
import type { WorkspaceMeta } from "../../../../../../src/shared/types/workspace";

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174010";

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

function makeManager(workspaces: WorkspaceMeta[]) {
  return {
    list: (): WorkspaceMeta[] => workspaces,
  };
}

function makeSshWorkspace(remotePath: string): WorkspaceMeta {
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

function context(signal: AbortSignal = new AbortController().signal): StreamContext {
  return { signal };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ssh-local-only-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("fs local-only SSH workspace guards", () => {
  it("rejects writeFile before touching a matching local path", async () => {
    const workspace = makeSshWorkspace(tmpRoot);
    const target = path.join(tmpRoot, "should-not-write.txt");
    const handler = writeFileHandler(makeManager([workspace]) as never);

    await expect(
      handler({
        workspaceId: WORKSPACE_ID,
        relPath: "should-not-write.txt",
        content: "local write should not happen",
        expected: { exists: false },
      }),
    ).rejects.toBeInstanceOf(UnsupportedSshWorkspaceError);

    expect(fs.existsSync(target)).toBe(false);
  });

  it("rejects search before walking a matching local path", async () => {
    fs.writeFileSync(path.join(tmpRoot, "local-only.txt"), "needle\n");
    const workspace = makeSshWorkspace(tmpRoot);
    const handler = searchTextStream(makeManager([workspace]) as never);
    const generator = handler(
      { workspaceId: WORKSPACE_ID, query: baseQuery({ pattern: "needle" }) },
      context(),
    );

    const err = await generator.next().catch((error: unknown) => error);
    expect(err).toBeInstanceOf(UnsupportedSshWorkspaceError);
    expect((err as Error).message).toContain(
      "SSH workspaces do not support search workspace files",
    );
  });

  it("no-ops watch and unwatch for SSH workspaces", async () => {
    const workspace = makeSshWorkspace(tmpRoot);
    const manager = makeManager([workspace]);
    const watcher = {
      watch: mock((_workspaceId: string, _workspaceRoot: string, _absDir: string) => {}),
      unwatch: mock((_workspaceId: string, _absDir: string) => {}),
    };

    await watchHandler(
      manager as never,
      watcher as never,
    )({
      workspaceId: WORKSPACE_ID,
      relPath: ".",
    });
    await unwatchHandler(
      manager as never,
      watcher as never,
    )({
      workspaceId: WORKSPACE_ID,
      relPath: ".",
    });

    expect(watcher.watch).not.toHaveBeenCalled();
    expect(watcher.unwatch).not.toHaveBeenCalled();
  });
});
