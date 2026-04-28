import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { LspDocumentSymbolsRequest } from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  buildDocumentSymbolsParams,
  LspDocumentSymbolsCapability,
  mapDocumentSymbolsResponse,
} from "./document-symbols";

const workspaceId = "ws_lsp_document_symbols" as WorkspaceId;
const request: LspDocumentSymbolsRequest = {
  type: "lsp-document-symbols/read",
  workspaceId,
  path: "src/index.ts",
  language: "typescript",
};

describe("LspDocumentSymbolsCapability", () => {
  test("builds textDocument/documentSymbol params", () => {
    expect(buildDocumentSymbolsParams("file:///workspace/src/index.ts")).toEqual({
      textDocument: { uri: "file:///workspace/src/index.ts" },
    });
  });

  test("maps DocumentSymbol and SymbolInformation response items", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-symbols-"));
    try {
      const uri = pathToFileURL(path.join(workspaceRoot, "src", "index.ts")).href;
      expect(
        mapDocumentSymbolsResponse(
          [
            {
              name: "Outer",
              detail: "class",
              kind: 5,
              tags: [1],
              range: protocolRange(0, 0, 10, 1),
              selectionRange: protocolRange(0, 6, 0, 11),
              children: [
                {
                  name: "method",
                  kind: 6,
                  range: protocolRange(1, 2, 3, 3),
                  selectionRange: protocolRange(1, 2, 1, 8),
                },
              ],
            },
            {
              name: "helper",
              kind: 12,
              tags: [1],
              containerName: "module",
              location: {
                uri,
                range: protocolRange(12, 0, 14, 1),
              },
            },
          ],
          workspaceRoot,
        ),
      ).toEqual([
        {
          type: "document-symbol",
          name: "Outer",
          detail: "class",
          kind: "class",
          tags: ["deprecated"],
          range: {
            start: { line: 0, character: 0 },
            end: { line: 10, character: 1 },
          },
          selectionRange: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 11 },
          },
          children: [
            {
              type: "document-symbol",
              name: "method",
              detail: null,
              kind: "method",
              tags: [],
              range: {
                start: { line: 1, character: 2 },
                end: { line: 3, character: 3 },
              },
              selectionRange: {
                start: { line: 1, character: 2 },
                end: { line: 1, character: 8 },
              },
              children: [],
            },
          ],
        },
        {
          type: "symbol-information",
          name: "helper",
          kind: "function",
          tags: ["deprecated"],
          containerName: "module",
          location: {
            uri,
            path: "src/index.ts",
            range: {
              start: { line: 12, character: 0 },
              end: { line: 14, character: 1 },
            },
          },
        },
      ]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("returns a timestamped bridge result through the request callback", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-symbols-"));
    try {
      const capability = new LspDocumentSymbolsCapability({
        now: () => new Date("2026-04-27T00:00:00.000Z"),
      });

      const result = await capability.documentSymbols({
        request,
        path: "src/index.ts",
        uri: "file:///workspace/src/index.ts",
        workspaceRoot,
        async sendRequest() {
          return [
            {
              name: "value",
              kind: 14,
              range: protocolRange(0, 0, 0, 20),
              selectionRange: protocolRange(0, 6, 0, 11),
            },
          ];
        },
      });

      expect(result).toMatchObject({
        type: "lsp-document-symbols/read/result",
        workspaceId,
        path: "src/index.ts",
        language: "typescript",
        symbols: [{ type: "document-symbol", name: "value", kind: "constant" }],
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
