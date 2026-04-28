import { describe, expect, test } from "bun:test";

import type { LspCodeActionRequest } from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  buildCodeActionParams,
  LspCodeActionCapability,
  mapCodeActionResponse,
} from "./code-action";

const workspaceId = "ws_lsp_code_action" as WorkspaceId;
const request: LspCodeActionRequest = {
  type: "lsp-code-action/list",
  workspaceId,
  path: "src/index.ts",
  language: "typescript",
  range: {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 5 },
  },
  diagnostics: [
    {
      path: "src/index.ts",
      language: "typescript",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      },
      severity: "error",
      message: "Missing import.",
      source: "typescript",
      code: 2304,
    },
  ],
  only: "quickfix",
};

describe("LspCodeActionCapability", () => {
  test("builds codeAction params with diagnostics and kind filter", () => {
    expect(buildCodeActionParams(request, "file:///repo/src/index.ts")).toEqual({
      textDocument: { uri: "file:///repo/src/index.ts" },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      },
      context: {
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 5 },
            },
            severity: 1,
            message: "Missing import.",
            source: "typescript",
            code: 2304,
          },
        ],
        only: ["quickfix"],
      },
    });
  });

  test("maps CodeAction and Command responses", () => {
    expect(
      mapCodeActionResponse(
        [
          {
            title: "Add import",
            kind: "quickfix",
            diagnostics: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                severity: 1,
                message: "Missing import.",
              },
            ],
            edit: {
              changes: {
                "file:///repo/src/index.ts": [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 0 },
                    },
                    newText: "import { value } from './value';\n",
                  },
                ],
              },
            },
            isPreferred: true,
          },
          {
            title: "Organize Imports",
            command: "source.organizeImports",
            arguments: ["src/index.ts"],
          },
        ],
        "/repo",
        "src/index.ts",
        "typescript",
      ),
    ).toEqual([
      {
        title: "Add import",
        kind: "quickfix",
        diagnostics: [
          {
            path: "src/index.ts",
            language: "typescript",
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 5 },
            },
            severity: "error",
            message: "Missing import.",
            source: null,
            code: null,
          },
        ],
        edit: {
          changes: [
            {
              path: "src/index.ts",
              edits: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 0 },
                  },
                  newText: "import { value } from './value';\n",
                },
              ],
            },
          ],
        },
        command: null,
        isPreferred: true,
        disabledReason: null,
      },
      {
        title: "Organize Imports",
        diagnostics: [],
        command: {
          title: "Organize Imports",
          command: "source.organizeImports",
          arguments: ["src/index.ts"],
        },
      },
    ]);
  });

  test("returns timestamped bridge result", async () => {
    const capability = new LspCodeActionCapability({
      now: () => new Date("2026-04-27T00:00:00.000Z"),
    });
    const result = await capability.codeActions({
      request,
      path: "src/index.ts",
      uri: "file:///repo/src/index.ts",
      workspaceRoot: "/repo",
      async sendRequest() {
        return [
          {
            title: "Add import",
            kind: "quickfix",
            edit: { changes: {} },
          },
        ];
      },
    });

    expect(result).toEqual({
      type: "lsp-code-action/list/result",
      workspaceId,
      path: "src/index.ts",
      language: "typescript",
      actions: [
        {
          title: "Add import",
          kind: "quickfix",
          diagnostics: [],
          edit: { changes: [] },
          command: null,
          isPreferred: null,
          disabledReason: null,
        },
      ],
      listedAt: "2026-04-27T00:00:00.000Z",
    });
  });
});
