import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  mapLspDefinitionToMonaco,
  registerLspDefinitionProvider,
} from "./definition-provider";

describe("Monaco LSP definition provider", () => {
  test("maps Location and LocationLink targets to Monaco definitions", () => {
    const monaco = createFakeMonaco();
    const result = mapLspDefinitionToMonaco(monaco, "ws_definition" as WorkspaceId, {
      type: "lsp-definition/read/result",
      workspaceId: "ws_definition" as WorkspaceId,
      path: "src/index.ts",
      language: "typescript",
      targets: [
        {
          type: "location",
          uri: "file:///workspace/src/value.ts",
          path: "src/value.ts",
          range: lspRange(2, 0, 2, 12),
        },
        {
          type: "location-link",
          targetUri: "file:///workspace/src/linked.ts",
          targetPath: "src/linked.ts",
          originSelectionRange: lspRange(1, 5, 1, 10),
          targetRange: lspRange(3, 0, 6, 1),
          targetSelectionRange: lspRange(3, 13, 3, 19),
        },
      ],
      readAt: "2026-04-27T00:00:00.000Z",
    });

    expect(result).toEqual([
      {
        uri: { value: "file:///nexus/ws_definition/src/value.ts" },
        range: new monaco.Range(3, 1, 3, 13),
      },
      {
        originSelectionRange: new monaco.Range(2, 6, 2, 11),
        uri: { value: "file:///nexus/ws_definition/src/linked.ts" },
        range: new monaco.Range(4, 1, 7, 2),
        targetSelectionRange: new monaco.Range(4, 14, 4, 20),
      },
    ]);
  });

  test("registers a model-scoped provider that invokes the editor bridge", async () => {
    const monaco = createFakeMonaco();
    const model = {};
    const requests: unknown[] = [];
    registerLspDefinitionProvider(monaco, {
      workspaceId: "ws_definition" as WorkspaceId,
      path: "src/index.ts",
      language: "typescript",
      languageId: "typescript",
      model: model as never,
      editorApi: {
        async invoke(request) {
          requests.push(request);
          return {
            type: "lsp-definition/read/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            targets: [],
            readAt: "2026-04-27T00:00:00.000Z",
          };
        },
      },
    });

    await monaco.registeredDefinitionProvider?.provider.provideDefinition(
      model,
      { lineNumber: 4, column: 9 },
    );
    expect(requests).toEqual([
      {
        type: "lsp-definition/read",
        workspaceId: "ws_definition",
        path: "src/index.ts",
        language: "typescript",
        position: { line: 3, character: 8 },
      },
    ]);
  });
});

function lspRange(
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

function createFakeMonaco() {
  class Range {
    public constructor(
      public readonly startLineNumber: number,
      public readonly startColumn: number,
      public readonly endLineNumber: number,
      public readonly endColumn: number,
    ) {}
  }

  const monaco = {
    Range,
    Uri: {
      parse(value: string) {
        return { value };
      },
    },
    languages: {
      registerDefinitionProvider(languageId: string, provider: unknown) {
        monaco.registeredDefinitionProvider = {
          languageId,
          provider: provider as {
            provideDefinition(model: unknown, position: { lineNumber: number; column: number }): Promise<unknown>;
          },
        };
        return { dispose() {} };
      },
    },
    registeredDefinitionProvider: null as null | {
      languageId: string;
      provider: {
        provideDefinition(model: unknown, position: { lineNumber: number; column: number }): Promise<unknown>;
      };
    },
  };
  return monaco as never;
}
