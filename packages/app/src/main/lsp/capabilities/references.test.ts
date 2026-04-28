import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { LspReferencesRequest } from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  buildReferencesParams,
  LspReferencesCapability,
  mapReferencesResponse,
} from "./references";

const workspaceId = "ws_lsp_references" as WorkspaceId;
const request: LspReferencesRequest = {
  type: "lsp-references/read",
  workspaceId,
  path: "src/index.ts",
  language: "typescript",
  position: { line: 1, character: 5 },
  includeDeclaration: true,
};

describe("LspReferencesCapability", () => {
  test("builds textDocument/references params from the editor bridge request", () => {
    expect(buildReferencesParams(request, "file:///workspace/src/index.ts")).toEqual({
      textDocument: { uri: "file:///workspace/src/index.ts" },
      position: { line: 1, character: 5 },
      context: { includeDeclaration: true },
    });
    expect(
      buildReferencesParams(
        { ...request, includeDeclaration: null },
        "file:///workspace/src/index.ts",
      ).context.includeDeclaration,
    ).toBe(false);
  });

  test("maps Location array responses to shared references", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-references-"));
    try {
      const uri = pathToFileURL(path.join(workspaceRoot, "src", "index.ts")).href;
      expect(
        mapReferencesResponse(
          [{ uri, range: protocolRange(2, 0, 2, 12) }, { targetUri: uri }],
          workspaceRoot,
        ),
      ).toEqual([
        {
          uri,
          path: "src/index.ts",
          range: {
            start: { line: 2, character: 0 },
            end: { line: 2, character: 12 },
          },
        },
      ]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("returns a timestamped bridge result through the request callback", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-references-"));
    try {
      const uri = pathToFileURL(path.join(workspaceRoot, "src", "index.ts")).href;
      const capability = new LspReferencesCapability({
        now: () => new Date("2026-04-27T00:00:00.000Z"),
      });

      const result = await capability.references({
        request,
        path: "src/index.ts",
        uri,
        workspaceRoot,
        async sendRequest() {
          return [{ uri, range: protocolRange(0, 0, 0, 5) }];
        },
      });

      expect(result).toMatchObject({
        type: "lsp-references/read/result",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        locations: [{ path: "src/index.ts" }],
        readAt: "2026-04-27T00:00:00.000Z",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

function protocolRange(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}
