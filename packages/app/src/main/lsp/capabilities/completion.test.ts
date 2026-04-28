import { describe, expect, test } from "bun:test";

import type { LspCompletionRequest } from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  buildCompletionParams,
  LspCompletionCapability,
  mapCompletionItemKind,
  mapCompletionResponse,
} from "./completion";

const workspaceId = "ws_lsp_completion" as WorkspaceId;
const request: LspCompletionRequest = {
  type: "lsp-completion/complete",
  workspaceId,
  path: "src/index.ts",
  language: "typescript",
  position: {
    line: 3,
    character: 12,
  },
  triggerKind: "trigger-character",
  triggerCharacter: ".",
};

describe("LspCompletionCapability", () => {
  test("builds textDocument/completion params from the editor bridge request", () => {
    expect(buildCompletionParams(request, "file:///workspace/src/index.ts")).toEqual({
      textDocument: {
        uri: "file:///workspace/src/index.ts",
      },
      position: {
        line: 3,
        character: 12,
      },
      context: {
        triggerKind: 2,
        triggerCharacter: ".",
      },
    });
  });

  test("maps CompletionList responses to editor completion items", () => {
    const items = mapCompletionResponse({
      isIncomplete: true,
      itemDefaults: {
        commitCharacters: [";"],
      },
      items: [
        {
          label: "console",
          kind: 6,
          detail: "Console",
          documentation: {
            kind: "markdown",
            value: "Writes to stdout.",
          },
          sortText: "0001",
          filterText: "console",
          insertText: "console",
          additionalTextEdits: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
              },
              newText: "import console\n",
            },
          ],
        },
      ],
    });

    expect(items).toEqual([
      {
        label: "console",
        kind: "variable",
        detail: "Console",
        documentation: "Writes to stdout.",
        sortText: "0001",
        filterText: "console",
        insertText: "console",
        insertTextFormat: "plain-text",
        range: null,
        additionalTextEdits: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
            newText: "import console\n",
          },
        ],
        commitCharacters: [";"],
        preselect: null,
        deprecated: null,
      },
    ]);
  });

  test("maps CompletionItemKind values to shared names", () => {
    expect([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      21, 22, 23, 24, 25,
    ].map((kind) => mapCompletionItemKind(kind))).toEqual([
      "text",
      "method",
      "function",
      "constructor",
      "field",
      "variable",
      "class",
      "interface",
      "module",
      "property",
      "unit",
      "value",
      "enum",
      "keyword",
      "snippet",
      "color",
      "file",
      "reference",
      "folder",
      "enum-member",
      "constant",
      "struct",
      "event",
      "operator",
      "type-parameter",
    ]);
    expect(mapCompletionItemKind(undefined)).toBe("text");
  });

  test("uses textEdit text before insertText and insertText before label", () => {
    expect(
      mapCompletionResponse([
        {
          label: "labelOnly",
        },
        {
          label: "label",
          insertText: "insertText",
        },
        {
          label: "label",
          insertText: "ignoredInsertText",
          textEdit: {
            range: {
              start: { line: 2, character: 4 },
              end: { line: 2, character: 8 },
            },
            newText: "textEditText",
          },
        },
      ]).map((item) => ({
        insertText: item.insertText,
        range: item.range,
      })),
    ).toEqual([
      {
        insertText: "labelOnly",
        range: null,
      },
      {
        insertText: "insertText",
        range: null,
      },
      {
        insertText: "textEditText",
        range: {
          start: { line: 2, character: 4 },
          end: { line: 2, character: 8 },
        },
      },
    ]);
  });

  test("maps snippets, insert-replace ranges, and additionalTextEdits", () => {
    const items = mapCompletionResponse([
      {
        label: "for",
        kind: 15,
        insertText: "for (const ${1:item} of ${2:items}) {\n\t$0\n}",
        insertTextFormat: 2,
        textEdit: {
          newText: "for (const ${1:item} of ${2:items}) {\n\t$0\n}",
          insert: {
            start: { line: 4, character: 2 },
            end: { line: 4, character: 5 },
          },
          replace: {
            start: { line: 4, character: 2 },
            end: { line: 4, character: 8 },
          },
        },
        additionalTextEdits: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
            newText: "import { items } from './items';\n",
          },
        ],
      },
    ]);

    expect(items[0]).toMatchObject({
      label: "for",
      kind: "snippet",
      insertText: "for (const ${1:item} of ${2:items}) {\n\t$0\n}",
      insertTextFormat: "snippet",
      range: {
        insert: {
          start: { line: 4, character: 2 },
          end: { line: 4, character: 5 },
        },
        replace: {
          start: { line: 4, character: 2 },
          end: { line: 4, character: 8 },
        },
      },
      additionalTextEdits: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: "import { items } from './items';\n",
        },
      ],
    });
  });

  test("returns timestamped bridge result through the request callback", async () => {
    const capability = new LspCompletionCapability({
      now: () => new Date("2026-04-27T00:00:00.000Z"),
    });
    const sentParams: unknown[] = [];

    const result = await capability.complete({
      request,
      path: "src/index.ts",
      uri: "file:///workspace/src/index.ts",
      async sendRequest(params) {
        sentParams.push(params);
        return {
          isIncomplete: false,
          items: [{ label: "value", kind: 12 }],
        };
      },
    });

    expect(sentParams).toHaveLength(1);
    expect(result).toEqual({
      type: "lsp-completion/complete/result",
      workspaceId,
      path: "src/index.ts",
      language: "typescript",
      isIncomplete: false,
      completedAt: "2026-04-27T00:00:00.000Z",
      items: [
        {
          label: "value",
          kind: "value",
          detail: null,
          documentation: null,
          sortText: null,
          filterText: null,
          insertText: "value",
          insertTextFormat: "plain-text",
          range: null,
          additionalTextEdits: [],
          commitCharacters: null,
          preselect: null,
          deprecated: null,
        },
      ],
    });
  });
});
