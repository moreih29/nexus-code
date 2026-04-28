import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { WorkspaceId, WorkspaceRegistry } from "../../../../shared/src/contracts/workspace/workspace";
import { ExternalFileDropService, FileClipboardService } from "./clipboard";

const workspaceId = "ws_alpha" as WorkspaceId;

describe("FileClipboardService", () => {
  test("reports collisions before mutating and can keep both on resolution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-clipboard-"));
    await writeFile(path.join(root, "source.txt"), "source");
    await mkdir(path.join(root, "target"), { recursive: true });
    await writeFile(path.join(root, "target", "source.txt"), "existing");

    const service = new FileClipboardService({ workspaceRegistryStore: registryStore(root) });
    const promptResult = await service.paste({
      type: "file-actions/clipboard/paste",
      workspaceId,
      targetDirectory: "target",
      operation: "copy",
      entries: [{ workspaceId, path: "source.txt", kind: "file" }],
      conflictStrategy: "prompt",
    });

    expect(promptResult.collisions).toEqual([
      { sourcePath: "source.txt", targetPath: "target/source.txt", kind: "file" },
    ]);
    expect(await readFile(path.join(root, "target", "source.txt"), "utf8")).toBe("existing");

    const keepBothResult = await service.paste({
      type: "file-actions/clipboard/paste",
      workspaceId,
      targetDirectory: "target",
      operation: "copy",
      entries: [{ workspaceId, path: "source.txt", kind: "file" }],
      conflictStrategy: "keep-both",
    });

    expect(keepBothResult.applied[0]?.targetPath).toBe("target/source_2.txt");
    expect(await readFile(path.join(root, "target", "source_2.txt"), "utf8")).toBe("source");
  });

  test("replaces existing targets only after explicit collision resolution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-clipboard-"));
    await writeFile(path.join(root, "source.txt"), "new");
    await mkdir(path.join(root, "target"), { recursive: true });
    await writeFile(path.join(root, "target", "source.txt"), "old");

    const service = new FileClipboardService({ workspaceRegistryStore: registryStore(root) });
    const promptResult = await service.paste({
      type: "file-actions/clipboard/paste",
      workspaceId,
      targetDirectory: "target",
      operation: "copy",
      entries: [{ workspaceId, path: "source.txt", kind: "file" }],
      conflictStrategy: "prompt",
    });

    expect(promptResult.applied).toEqual([]);
    expect(await readFile(path.join(root, "target", "source.txt"), "utf8")).toBe("old");

    const replaceResult = await service.paste({
      type: "file-actions/clipboard/paste",
      workspaceId,
      targetDirectory: "target",
      operation: "copy",
      entries: [{ workspaceId, path: "source.txt", kind: "file" }],
      conflictStrategy: "replace",
    });

    expect(replaceResult.applied[0]?.targetPath).toBe("target/source.txt");
    expect(await readFile(path.join(root, "target", "source.txt"), "utf8")).toBe("new");
  });

  test("cuts by renaming and rejects moving a directory into itself", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-clipboard-"));
    await mkdir(path.join(root, "src", "child"), { recursive: true });
    await writeFile(path.join(root, "src", "child", "file.txt"), "hello");
    await mkdir(path.join(root, "dest"), { recursive: true });

    const service = new FileClipboardService({ workspaceRegistryStore: registryStore(root) });
    const cutResult = await service.paste({
      type: "file-actions/clipboard/paste",
      workspaceId,
      targetDirectory: "dest",
      operation: "cut",
      entries: [{ workspaceId, path: "src/child/file.txt", kind: "file" }],
      conflictStrategy: "prompt",
    });

    expect(cutResult.applied[0]?.targetPath).toBe("dest/file.txt");
    expect(await readFile(path.join(root, "dest", "file.txt"), "utf8")).toBe("hello");
    await expect(stat(path.join(root, "src", "child", "file.txt"))).rejects.toThrow();

    await expect(service.paste({
      type: "file-actions/clipboard/paste",
      workspaceId,
      targetDirectory: "src/child",
      operation: "cut",
      entries: [{ workspaceId, path: "src", kind: "directory" }],
      conflictStrategy: "prompt",
    })).rejects.toThrow("Cannot move a directory into itself");
  });

  test("copies external drag-in files, reports large files, and resolves collisions with keep-both", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "nexus-external-drop-workspace-"));
    const externalRoot = await mkdtemp(path.join(tmpdir(), "nexus-external-drop-source-"));
    const sourcePath = path.join(externalRoot, "source.txt");
    await writeFile(sourcePath, "source");
    await writeFile(path.join(workspaceRoot, "source.txt"), "existing");

    const service = new ExternalFileDropService({ workspaceRegistryStore: registryStore(workspaceRoot) });
    const promptResult = await service.copyIntoWorkspace({
      type: "file-actions/external-drag-in",
      workspaceId,
      targetDirectory: null,
      files: [{ absolutePath: sourcePath, name: "source.txt", size: 101 * 1024 * 1024 }],
      conflictStrategy: "prompt",
    });

    expect(promptResult.collisions).toEqual([
      { sourcePath, targetPath: "source.txt", kind: "file" },
    ]);
    expect(promptResult.largeFiles).toEqual([
      { sourcePath, size: 101 * 1024 * 1024 },
    ]);
    expect(await readFile(path.join(workspaceRoot, "source.txt"), "utf8")).toBe("existing");

    const keepBothResult = await service.copyIntoWorkspace({
      type: "file-actions/external-drag-in",
      workspaceId,
      targetDirectory: null,
      files: [{ absolutePath: sourcePath, name: "source.txt", size: 10 }],
      conflictStrategy: "keep-both",
    });

    expect(keepBothResult.applied[0]?.targetPath).toBe("source_2.txt");
    expect(await readFile(path.join(workspaceRoot, "source_2.txt"), "utf8")).toBe("source");
    expect(await readFile(sourcePath, "utf8")).toBe("source");
  });

  test("smoke-verifies external drag-in of 5 files", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "nexus-external-drop-workspace-"));
    const externalRoot = await mkdtemp(path.join(tmpdir(), "nexus-external-drop-source-"));
    const files = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const sourcePath = path.join(externalRoot, `source-${index}.txt`);
        await writeFile(sourcePath, `source-${index}`);
        return {
          absolutePath: sourcePath,
          name: `source-${index}.txt`,
          size: 10,
        };
      }),
    );

    const service = new ExternalFileDropService({ workspaceRegistryStore: registryStore(workspaceRoot) });
    const result = await service.copyIntoWorkspace({
      type: "file-actions/external-drag-in",
      workspaceId,
      targetDirectory: null,
      files,
      conflictStrategy: "prompt",
    });

    expect(result.collisions).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.applied.map((entry) => entry.targetPath)).toEqual([
      "source-0.txt",
      "source-1.txt",
      "source-2.txt",
      "source-3.txt",
      "source-4.txt",
    ]);

    for (let index = 0; index < 5; index += 1) {
      expect(await readFile(path.join(workspaceRoot, `source-${index}.txt`), "utf8")).toBe(`source-${index}`);
    }
  });
});

function registryStore(root: string) {
  const registry: WorkspaceRegistry = {
    version: 1,
    workspaces: [
      {
        id: workspaceId,
        absolutePath: root,
        displayName: "Alpha",
        createdAt: "2026-04-28T00:00:00.000Z",
        lastOpenedAt: "2026-04-28T00:00:00.000Z",
      },
    ],
  };

  return {
    async getWorkspaceRegistry() {
      return registry;
    },
  };
}
