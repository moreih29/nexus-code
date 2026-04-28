import { describe, expect, test } from "bun:test";

import type {
  LspPrepareRenameRequest,
  LspRenameRequest,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  buildPrepareRenameParams,
  buildRenameParams,
  LspRenameCapability,
  mapPrepareRenameResponse,
} from "./rename";

const workspaceId = "ws_lsp_rename" as WorkspaceId;
const prepareRequest: LspPrepareRenameRequest = {
  type: "lsp-rename/prepare",
  workspaceId,
  path: "src/index.ts",
  language: "typescript",
  position: { line: 1, character: 7 },
};
const renameRequest: LspRenameRequest = {
  type: "lsp-rename/rename",
  workspaceId,
  path: "src/index.ts",
  language: "typescript",
  position: { line: 1, character: 7 },
  newName: "nextValue",
};

describe("LspRenameCapability", () => {
  test("builds prepareRename and rename params", () => {
    expect(buildPrepareRenameParams(prepareRequest, "file:///repo/src/index.ts")).toEqual({
      textDocument: { uri: "file:///repo/src/index.ts" },
      position: { line: 1, character: 7 },
    });
    expect(buildRenameParams(renameRequest, "file:///repo/src/index.ts")).toEqual({
      textDocument: { uri: "file:///repo/src/index.ts" },
      position: { line: 1, character: 7 },
      newName: "nextValue",
    });
  });

  test("maps prepareRename range, placeholder, defaultBehavior, and rejection responses", () => {
    expect(
      mapPrepareRenameResponse({
        range: {
          start: { line: 1, character: 4 },
          end: { line: 1, character: 9 },
        },
        placeholder: "value",
      }),
    ).toEqual({
      canRename: true,
      range: {
        start: { line: 1, character: 4 },
        end: { line: 1, character: 9 },
      },
      placeholder: "value",
      defaultBehavior: false,
    });
    expect(mapPrepareRenameResponse({ defaultBehavior: true })).toEqual({
      canRename: true,
      range: null,
      placeholder: null,
      defaultBehavior: true,
    });
    expect(mapPrepareRenameResponse(null)).toEqual({
      canRename: false,
      range: null,
      placeholder: null,
      defaultBehavior: false,
    });
  });

  test("maps rename WorkspaceEdit to workspace-relative paths", async () => {
    const capability = new LspRenameCapability({
      now: () => new Date("2026-04-27T00:00:00.000Z"),
    });
    const result = await capability.rename({
      request: renameRequest,
      path: "src/index.ts",
      uri: "file:///repo/src/index.ts",
      workspaceRoot: "/repo",
      async sendRequest() {
        return {
          changes: {
            "file:///repo/src/index.ts": [
              {
                range: {
                  start: { line: 1, character: 4 },
                  end: { line: 1, character: 9 },
                },
                newText: "nextValue",
              },
            ],
            "file:///repo/src/other.ts": [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                newText: "nextValue",
              },
            ],
          },
        };
      },
    });

    expect(result).toEqual({
      type: "lsp-rename/rename/result",
      workspaceId,
      path: "src/index.ts",
      language: "typescript",
      workspaceEdit: {
        changes: [
          {
            path: "src/index.ts",
            edits: [
              {
                range: {
                  start: { line: 1, character: 4 },
                  end: { line: 1, character: 9 },
                },
                newText: "nextValue",
              },
            ],
          },
          {
            path: "src/other.ts",
            edits: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                newText: "nextValue",
              },
            ],
          },
        ],
      },
      renamedAt: "2026-04-27T00:00:00.000Z",
    });
  });
});
