import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { EditorBridgeEvent } from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import { resolveWorkspaceFilePath } from "../../workspace/files/workspace-files-paths";
import { LspDiagnosticsCapability } from "./diagnostics";

const tempDirs: string[] = [];
const workspaceId = "ws_lsp_diagnostics" as WorkspaceId;
const now = () => new Date("2026-04-27T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })),
  );
});

describe("LspDiagnosticsCapability", () => {
  test("maps and reads published diagnostics through the extracted capability seam", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    await mkdir(path.join(workspaceRoot, "pkg"), { recursive: true });
    const observedEvents: EditorBridgeEvent[] = [];
    const capability = new LspDiagnosticsCapability({
      now,
      emitEvent: (event) => observedEvents.push(event),
      resolveRequestPath: async (_workspaceId, requestPath, fieldName) =>
        resolveWorkspaceFilePath(workspaceRoot, requestPath, { fieldName }),
    });
    const absoluteFilePath = path.join(workspaceRoot, "pkg", "module.py");

    capability.handlePublishDiagnostics({
      workspaceId,
      workspaceRoot,
      language: "python",
      params: {
        uri: pathToFileURL(absoluteFilePath).href,
        version: 12,
        diagnostics: [
          {
            range: {
              start: { line: 2, character: 4 },
              end: { line: 2, character: 11 },
            },
            severity: 2,
            message: "Unused import.",
            source: "pyright",
            code: "reportUnusedImport",
          },
        ],
      },
    });

    expect(observedEvents).toEqual([
      {
        type: "lsp-diagnostics/changed",
        workspaceId,
        path: "pkg/module.py",
        language: "python",
        diagnostics: [
          {
            path: "pkg/module.py",
            language: "python",
            range: {
              start: { line: 2, character: 4 },
              end: { line: 2, character: 11 },
            },
            severity: "warning",
            message: "Unused import.",
            source: "pyright",
            code: "reportUnusedImport",
          },
        ],
        version: "12",
        publishedAt: "2026-04-27T00:00:00.000Z",
      },
    ]);

    const read = await capability.readDiagnostics({
      type: "lsp-diagnostics/read",
      workspaceId,
      path: "pkg/module.py",
      language: "python",
    });

    expect(read).toEqual({
      type: "lsp-diagnostics/read/result",
      workspaceId,
      diagnostics: [
        {
          path: "pkg/module.py",
          language: "python",
          range: {
            start: { line: 2, character: 4 },
            end: { line: 2, character: 11 },
          },
          severity: "warning",
          message: "Unused import.",
          source: "pyright",
          code: "reportUnusedImport",
        },
      ],
      readAt: "2026-04-27T00:00:00.000Z",
    });

    capability.clearDiagnostics(workspaceId, "python", "pkg/module.py");
    const cleared = await capability.readDiagnostics({
      type: "lsp-diagnostics/read",
      workspaceId,
      path: "pkg/module.py",
      language: "python",
    });
    expect(cleared.diagnostics).toEqual([]);
  });
});

async function createWorkspaceRoot(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "nexus-lsp-diagnostics-"));
  tempDirs.push(tempDir);
  return tempDir;
}
