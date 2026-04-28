import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { LspDefinitionRequest } from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  buildDefinitionParams,
  LspDefinitionCapability,
  mapDefinitionResponse,
} from "./definition";

const workspaceId = "ws_lsp_definition" as WorkspaceId;
const request: LspDefinitionRequest = {
  type: "lsp-definition/read",
  workspaceId,
  path: "src/index.ts",
  language: "typescript",
  position: { line: 1, character: 5 },
};

describe("LspDefinitionCapability", () => {
  test("builds textDocument/definition params from the editor bridge request", () => {
    expect(buildDefinitionParams(request, "file:///workspace/src/index.ts")).toEqual({
      textDocument: { uri: "file:///workspace/src/index.ts" },
      position: { line: 1, character: 5 },
    });
  });

  test("maps Location and LocationLink responses to shared definition targets", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-definition-"));
    try {
      const targetUri = pathToFileURL(path.join(workspaceRoot, "src", "value.ts")).href;
      expect(
        mapDefinitionResponse(
          [
            {
              uri: targetUri,
              range: protocolRange(2, 0, 2, 12),
            },
            {
              targetUri,
              originSelectionRange: protocolRange(1, 5, 1, 10),
              targetRange: protocolRange(2, 0, 5, 1),
              targetSelectionRange: protocolRange(2, 13, 2, 18),
            },
          ],
          workspaceRoot,
        ),
      ).toEqual([
        {
          type: "location",
          uri: targetUri,
          path: "src/value.ts",
          range: {
            start: { line: 2, character: 0 },
            end: { line: 2, character: 12 },
          },
        },
        {
          type: "location-link",
          targetUri,
          targetPath: "src/value.ts",
          originSelectionRange: {
            start: { line: 1, character: 5 },
            end: { line: 1, character: 10 },
          },
          targetRange: {
            start: { line: 2, character: 0 },
            end: { line: 5, character: 1 },
          },
          targetSelectionRange: {
            start: { line: 2, character: 13 },
            end: { line: 2, character: 18 },
          },
        },
      ]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("returns a timestamped bridge result through the request callback", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-definition-"));
    try {
      const targetUri = pathToFileURL(path.join(workspaceRoot, "src", "value.ts")).href;
      const capability = new LspDefinitionCapability({
        now: () => new Date("2026-04-27T00:00:00.000Z"),
      });

      const result = await capability.definition({
        request,
        path: "src/index.ts",
        uri: "file:///workspace/src/index.ts",
        workspaceRoot,
        async sendRequest() {
          return { uri: targetUri, range: protocolRange(0, 0, 0, 5) };
        },
      });

      expect(result).toMatchObject({
        type: "lsp-definition/read/result",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        targets: [{ type: "location", path: "src/value.ts" }],
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
