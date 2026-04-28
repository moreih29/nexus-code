import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { EditorBridgeEvent } from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId, WorkspaceRegistry } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  WorkspaceFilesService,
  mapPorcelainStatusToGitBadge,
  parseGitStatusBadges,
  type WorkspaceFilesExecFile,
  type WorkspaceFilesWatchFactory,
} from "./workspace-files-service";

const tempDirs: string[] = [];
const workspaceId = "ws_workspace_files" as WorkspaceId;
const fixedNow = () => new Date("2026-04-27T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

describe("WorkspaceFilesService", () => {
  test("rejects path traversal outside the registered workspace", async () => {
    const workspaceRoot = await createTempWorkspace();
    const service = createService(workspaceRoot);

    await expect(
      service.readFile({
        type: "workspace-files/file/read",
        workspaceId,
        path: "../outside.txt",
      }),
    ).rejects.toThrow("path cannot traverse outside the workspace");
  });

  test("rejects symlink escapes before reading through workspace paths", async () => {
    const workspaceRoot = await createTempWorkspace();
    const outsideRoot = await createTempWorkspace();
    await writeFile(path.join(outsideRoot, "secret.txt"), "secret\n");
    await symlink(path.join(outsideRoot, "secret.txt"), path.join(workspaceRoot, "link.txt"));
    const service = createService(workspaceRoot);

    await expect(
      service.readFile({
        type: "workspace-files/file/read",
        workspaceId,
        path: "link.txt",
      }),
    ).rejects.toThrow("path cannot traverse outside the workspace");
  });

  test("scans a sorted file tree with git badges and ignored heavy directories", async () => {
    const workspaceRoot = await createTempWorkspace();
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
    await mkdir(path.join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(path.join(workspaceRoot, "README.md"), "hello\n");
    await writeFile(path.join(workspaceRoot, ".git", "config"), "[core]\n");
    await writeFile(path.join(workspaceRoot, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
    const service = createService(workspaceRoot, {
      execFile: async () => ({
        stdout: " M src/index.ts\n?? README.md\n",
        stderr: "",
      }),
    });

    const result = await service.readFileTree({
      type: "workspace-files/tree/read",
      workspaceId,
    });

    expect(result.type).toBe("workspace-files/tree/read/result");
    expect(result.rootPath).toBe("");
    expect(result.nodes.map((node) => [node.kind, node.path, node.gitBadge])).toEqual([
      ["directory", "src", "modified"],
      ["file", "README.md", "untracked"],
    ]);
    expect(result.nodes[0]?.children?.map((node) => [node.kind, node.path, node.gitBadge])).toEqual([
      ["file", "src/index.ts", "modified"],
    ]);
    expect(result.nodes.some((node) => node.path === ".git")).toBe(false);
    expect(result.nodes.some((node) => node.path === "node_modules")).toBe(false);
  });

  test("creates, reads, writes, renames, and deletes editor files", async () => {
    const workspaceRoot = await createTempWorkspace();
    const service = createService(workspaceRoot);
    const observedEvents: EditorBridgeEvent[] = [];
    service.onEvent((event) => observedEvents.push(event));

    await expect(
      service.createFile({
        type: "workspace-files/file/create",
        workspaceId,
        path: "src/new.ts",
        kind: "file",
        content: "export const value = 1;\n",
      }),
    ).resolves.toMatchObject({
      type: "workspace-files/file/create/result",
      path: "src/new.ts",
      kind: "file",
    });
    await expect(readFile(path.join(workspaceRoot, "src", "new.ts"), "utf8")).resolves.toBe(
      "export const value = 1;\n",
    );

    const readResult = await service.readFile({
      type: "workspace-files/file/read",
      workspaceId,
      path: "src/new.ts",
    });
    expect(readResult.content).toBe("export const value = 1;\n");

    await expect(
      service.writeFile({
        type: "workspace-files/file/write",
        workspaceId,
        path: "src/new.ts",
        content: "export const value = 2;\n",
        expectedVersion: readResult.version,
      }),
    ).resolves.toMatchObject({
      type: "workspace-files/file/write/result",
      path: "src/new.ts",
      encoding: "utf8",
    });

    await expect(
      service.renameFile({
        type: "workspace-files/file/rename",
        workspaceId,
        oldPath: "src/new.ts",
        newPath: "src/renamed.ts",
      }),
    ).resolves.toMatchObject({
      type: "workspace-files/file/rename/result",
      oldPath: "src/new.ts",
      newPath: "src/renamed.ts",
    });

    await expect(
      service.deleteFile({
        type: "workspace-files/file/delete",
        workspaceId,
        path: "src/renamed.ts",
      }),
    ).resolves.toMatchObject({
      type: "workspace-files/file/delete/result",
      path: "src/renamed.ts",
    });

    expect(observedEvents.filter((event) => event.type === "workspace-files/watch")).toEqual([
      {
        type: "workspace-files/watch",
        workspaceId,
        path: "src/new.ts",
        oldPath: null,
        kind: "file",
        change: "created",
        occurredAt: "2026-04-27T00:00:00.000Z",
      },
      {
        type: "workspace-files/watch",
        workspaceId,
        path: "src/new.ts",
        oldPath: null,
        kind: "file",
        change: "changed",
        occurredAt: "2026-04-27T00:00:00.000Z",
      },
      {
        type: "workspace-files/watch",
        workspaceId,
        path: "src/renamed.ts",
        oldPath: "src/new.ts",
        kind: "file",
        change: "renamed",
        occurredAt: "2026-04-27T00:00:00.000Z",
      },
      {
        type: "workspace-files/watch",
        workspaceId,
        path: "src/renamed.ts",
        oldPath: null,
        kind: "file",
        change: "deleted",
        occurredAt: "2026-04-27T00:00:00.000Z",
      },
    ]);
  });

  test("maps git porcelain status to workspace git badge states and returns clean requested paths", async () => {
    expect(mapPorcelainStatusToGitBadge(" M")).toBe("modified");
    expect(mapPorcelainStatusToGitBadge("A ")).toBe("staged");
    expect(mapPorcelainStatusToGitBadge("??")).toBe("untracked");
    expect(parseGitStatusBadges(" M src/modified.ts\nA  src/staged.ts\n?? scratch.txt\n")).toEqual(
      new Map([
        ["src/modified.ts", "modified"],
        ["src", "staged"],
        ["src/staged.ts", "staged"],
        ["scratch.txt", "untracked"],
      ]),
    );

    const workspaceRoot = await createTempWorkspace();
    const service = createService(workspaceRoot, {
      execFile: async () => ({
        stdout: " M src/modified.ts\nA  src/staged.ts\n?? scratch.txt\n",
        stderr: "",
      }),
    });

    await expect(
      service.readGitBadges({
        type: "workspace-git-badges/read",
        workspaceId,
        paths: ["src/modified.ts", "src/staged.ts", "clean.ts"],
      }),
    ).resolves.toMatchObject({
      type: "workspace-git-badges/read/result",
      badges: [
        { path: "src/modified.ts", status: "modified" },
        { path: "src/staged.ts", status: "staged" },
        { path: "clean.ts", status: "clean" },
      ],
    });
  });

  test("subscribes to watch events and stops delivering after listener disposal", async () => {
    const workspaceRoot = await createTempWorkspace();
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "src", "index.ts"), "export {};\n");
    const watchHandles: Array<{ closed: boolean }> = [];
    let watchListener: ((eventType: string, filename: string | Buffer | null) => void) | null = null;
    const watchFactory: WorkspaceFilesWatchFactory = (_root, options, listener) => {
      expect(options).toEqual({ recursive: true });
      watchListener = listener;
      const handle = { closed: false };
      watchHandles.push(handle);
      return {
        close() {
          handle.closed = true;
        },
      };
    };
    const service = createService(workspaceRoot, { watchFactory });
    const observedEvents: EditorBridgeEvent[] = [];
    const subscription = service.onEvent((event) => observedEvents.push(event));

    await service.readFileTree({ type: "workspace-files/tree/read", workspaceId });
    watchListener?.("change", "src/index.ts");
    await waitFor(() => {
      expect(observedEvents.filter((event) => event.type === "workspace-files/watch")).toHaveLength(1);
    });

    subscription.dispose();
    watchListener?.("change", "src/index.ts");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(observedEvents.filter((event) => event.type === "workspace-files/watch")).toEqual([
      {
        type: "workspace-files/watch",
        workspaceId,
        path: "src/index.ts",
        oldPath: null,
        kind: "file",
        change: "changed",
        occurredAt: "2026-04-27T00:00:00.000Z",
      },
    ]);

    service.dispose();
    expect(watchHandles).toEqual([{ closed: true }]);
  });

  test("ignores native watch events from hidden and heavy tree roots", async () => {
    const workspaceRoot = await createTempWorkspace();
    await mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
    await mkdir(path.join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await writeFile(path.join(workspaceRoot, ".git", "index"), "");
    await writeFile(path.join(workspaceRoot, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
    await writeFile(path.join(workspaceRoot, "src", "index.ts"), "export {};\n");
    let watchListener: ((eventType: string, filename: string | Buffer | null) => void) | null = null;
    const watchFactory: WorkspaceFilesWatchFactory = (_root, _options, listener) => {
      watchListener = listener;
      return { close() {} };
    };
    const service = createService(workspaceRoot, { watchFactory });
    const observedEvents: EditorBridgeEvent[] = [];
    service.onEvent((event) => observedEvents.push(event));

    await service.readFileTree({ type: "workspace-files/tree/read", workspaceId });
    watchListener?.("change", ".git/index");
    watchListener?.("rename", ".git");
    watchListener?.("change", Buffer.from("node_modules/pkg/index.js"));
    watchListener?.("change", "src/index.ts");

    await waitFor(() => {
      expect(observedEvents.filter((event) => event.type === "workspace-files/watch")).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(observedEvents.filter((event) => event.type === "workspace-files/watch")).toEqual([
      {
        type: "workspace-files/watch",
        workspaceId,
        path: "src/index.ts",
        oldPath: null,
        kind: "file",
        change: "changed",
        occurredAt: "2026-04-27T00:00:00.000Z",
      },
    ]);
  });
});

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-workspace-files-"));
  tempDirs.push(workspaceRoot);
  return workspaceRoot;
}

function createService(
  workspaceRoot: string,
  options: {
    execFile?: WorkspaceFilesExecFile;
    watchFactory?: WorkspaceFilesWatchFactory | null;
  } = {},
): WorkspaceFilesService {
  const registry: WorkspaceRegistry = {
    version: 1,
    workspaces: [
      {
        id: workspaceId,
        absolutePath: workspaceRoot,
        displayName: "workspace",
        createdAt: "2026-04-27T00:00:00.000Z",
        lastOpenedAt: "2026-04-27T00:00:00.000Z",
      },
    ],
  };

  return new WorkspaceFilesService({
    workspacePersistenceStore: {
      getWorkspaceRegistry: async () => registry,
    },
    execFile: options.execFile ?? (async () => ({ stdout: "", stderr: "" })),
    watchFactory: options.watchFactory ?? null,
    now: fixedNow,
  });
}

async function waitFor(assertion: () => void, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Timed out waiting for assertion.");
}
