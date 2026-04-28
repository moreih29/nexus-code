import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  mapLspReferencesToMonaco,
  registerLspReferencesProvider,
} from "./references-provider";

describe("Monaco LSP references provider", () => {
  test("maps shared reference locations to Monaco locations", () => {
    const monaco = createFakeMonaco();
    expect(
      mapLspReferencesToMonaco(monaco, "ws_references" as WorkspaceId, {
        type: "lsp-references/read/result",
        workspaceId: "ws_references" as WorkspaceId,
        path: "src/index.ts",
        language: "typescript",
        locations: [
          {
            uri: "file:///workspace/src/index.ts",
            path: "src/index.ts",
            range: lspRange(2, 4, 2, 10),
          },
        ],
        readAt: "2026-04-27T00:00:00.000Z",
      }),
    ).toEqual([
      {
        uri: { value: "file:///nexus/ws_references/src/index.ts" },
        range: new monaco.Range(3, 5, 3, 11),
      },
    ]);
  });

  test("registers a model-scoped provider that forwards includeDeclaration", async () => {
    const monaco = createFakeMonaco();
    const model = {};
    const requests: unknown[] = [];
    registerLspReferencesProvider(monaco, {
      workspaceId: "ws_references" as WorkspaceId,
      path: "src/index.ts",
      language: "typescript",
      languageId: "typescript",
      model: model as never,
      editorApi: {
        async invoke(request) {
          requests.push(request);
          return {
            type: "lsp-references/read/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            locations: [],
            readAt: "2026-04-27T00:00:00.000Z",
          };
        },
      },
    });

    await monaco.registeredReferenceProvider?.provider.provideReferences(
      model,
      { lineNumber: 4, column: 9 },
      { includeDeclaration: true },
    );
    expect(requests).toEqual([
      {
        type: "lsp-references/read",
        workspaceId: "ws_references",
        path: "src/index.ts",
        language: "typescript",
        position: { line: 3, character: 8 },
        includeDeclaration: true,
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
      registerReferenceProvider(languageId: string, provider: unknown) {
        monaco.registeredReferenceProvider = {
          languageId,
          provider: provider as {
            provideReferences(
              model: unknown,
              position: { lineNumber: number; column: number },
              context: { includeDeclaration: boolean },
            ): Promise<unknown>;
          },
        };
        return { dispose() {} };
      },
    },
    registeredReferenceProvider: null as null | {
      languageId: string;
      provider: {
        provideReferences(
          model: unknown,
          position: { lineNumber: number; column: number },
          context: { includeDeclaration: boolean },
        ): Promise<unknown>;
      };
    },
  };
  return monaco as never;
}
