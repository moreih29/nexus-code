import { describe, expect, test } from "bun:test";

import type {
  LspDocumentFormattingRequest,
  LspRangeFormattingRequest,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  buildDocumentFormattingParams,
  buildRangeFormattingParams,
  LspFormattingCapability,
} from "./formatting";

const workspaceId = "ws_lsp_formatting" as WorkspaceId;
const documentRequest: LspDocumentFormattingRequest = {
  type: "lsp-formatting/document",
  workspaceId,
  path: "src/index.ts",
  language: "typescript",
  options: {
    tabSize: 2,
    insertSpaces: true,
  },
};
const rangeRequest: LspRangeFormattingRequest = {
  type: "lsp-formatting/range",
  workspaceId,
  path: "src/index.ts",
  language: "typescript",
  range: {
    start: { line: 0, character: 0 },
    end: { line: 1, character: 0 },
  },
  options: {
    tabSize: 4,
    insertSpaces: false,
  },
};

describe("LspFormattingCapability", () => {
  test("builds document and range formatting params", () => {
    expect(buildDocumentFormattingParams(documentRequest, "file:///repo/src/index.ts")).toEqual({
      textDocument: { uri: "file:///repo/src/index.ts" },
      options: {
        tabSize: 2,
        insertSpaces: true,
        trimTrailingWhitespace: undefined,
        insertFinalNewline: undefined,
        trimFinalNewlines: undefined,
      },
    });
    expect(buildRangeFormattingParams(rangeRequest, "file:///repo/src/index.ts")).toEqual({
      textDocument: { uri: "file:///repo/src/index.ts" },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 0 },
      },
      options: {
        tabSize: 4,
        insertSpaces: false,
        trimTrailingWhitespace: undefined,
        insertFinalNewline: undefined,
        trimFinalNewlines: undefined,
      },
    });
  });

  test("maps TextEdit[] responses to shared edits", async () => {
    const capability = new LspFormattingCapability({
      now: () => new Date("2026-04-27T00:00:00.000Z"),
    });
    const result = await capability.documentFormatting({
      request: documentRequest,
      path: "src/index.ts",
      uri: "file:///repo/src/index.ts",
      async sendRequest() {
        return [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 11 },
            },
            newText: "const x = 1;",
          },
        ];
      },
    });

    expect(result).toEqual({
      type: "lsp-formatting/document/result",
      workspaceId,
      path: "src/index.ts",
      language: "typescript",
      edits: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 11 },
          },
          newText: "const x = 1;",
        },
      ],
      formattedAt: "2026-04-27T00:00:00.000Z",
    });
  });
});
