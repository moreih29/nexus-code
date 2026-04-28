import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  escapeMarkdownPlaintext,
  mapLspHoverContentToMonaco,
  mapLspHoverToMonaco,
  registerLspHoverProvider,
} from "./hover-provider";

describe("Monaco LSP hover provider", () => {
  test("maps markdown as markdown and escapes plaintext hover content", () => {
    expect(mapLspHoverContentToMonaco({ kind: "markdown", value: "**value**" })).toEqual({
      value: "**value**",
      isTrusted: false,
      supportHtml: false,
    });
    expect(escapeMarkdownPlaintext("literal **not** [link](x)")).toBe(
      "literal \\*\\*not\\*\\* \\[link\\]\\(x\\)",
    );
  });

  test("preserves Korean and unicode hover text when converting to Monaco markdown strings", () => {
    const koreanMarkdown = "### 값 설명\n\n한국어 hover 문서 ✅";
    const koreanPlaintext = "한국어 일반 텍스트 hover 설명 ✅";

    expect(mapLspHoverContentToMonaco({ kind: "markdown", value: koreanMarkdown })).toEqual({
      value: koreanMarkdown,
      isTrusted: false,
      supportHtml: false,
    });
    expect(mapLspHoverContentToMonaco({ kind: "plaintext", value: koreanPlaintext })).toEqual({
      value: koreanPlaintext,
      isTrusted: false,
      supportHtml: false,
    });
  });

  test("maps hover range and contents to Monaco hover", () => {
    const monaco = createFakeMonaco();
    expect(
      mapLspHoverToMonaco(monaco, {
        type: "lsp-hover/read/result",
        workspaceId: "ws_hover" as WorkspaceId,
        path: "src/index.ts",
        language: "typescript",
        contents: [{ kind: "plaintext", value: "value: number" }],
        range: {
          start: { line: 1, character: 2 },
          end: { line: 1, character: 7 },
        },
        readAt: "2026-04-27T00:00:00.000Z",
      }),
    ).toEqual({
      contents: [
        {
          value: "value: number",
          isTrusted: false,
          supportHtml: false,
        },
      ],
      range: new monaco.Range(2, 3, 2, 8),
    });
  });

  test("registers a model-scoped provider that invokes the editor bridge", async () => {
    const monaco = createFakeMonaco();
    const model = {};
    const otherModel = {};
    const requests: unknown[] = [];
    registerLspHoverProvider(monaco, {
      workspaceId: "ws_hover" as WorkspaceId,
      path: "src/index.ts",
      language: "typescript",
      languageId: "typescript",
      model: model as never,
      editorApi: {
        async invoke(request) {
          requests.push(request);
          return {
            type: "lsp-hover/read/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            contents: [{ kind: "markdown", value: "`value`" }],
            range: null,
            readAt: "2026-04-27T00:00:00.000Z",
          };
        },
      },
    });

    await expect(
      monaco.registeredHoverProvider?.provider.provideHover(
        otherModel,
        { lineNumber: 2, column: 8 },
      ),
    ).resolves.toBeNull();
    await expect(
      monaco.registeredHoverProvider?.provider.provideHover(
        model,
        { lineNumber: 2, column: 8 },
      ),
    ).resolves.toMatchObject({ contents: [{ value: "`value`" }] });
    expect(requests).toEqual([
      {
        type: "lsp-hover/read",
        workspaceId: "ws_hover",
        path: "src/index.ts",
        language: "typescript",
        position: { line: 1, character: 7 },
      },
    ]);
  });
});

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
    languages: {
      registerHoverProvider(languageId: string, provider: unknown) {
        monaco.registeredHoverProvider = {
          languageId,
          provider: provider as {
            provideHover(model: unknown, position: { lineNumber: number; column: number }): Promise<unknown>;
          },
        };
        return { dispose() {} };
      },
    },
    registeredHoverProvider: null as null | {
      languageId: string;
      provider: {
        provideHover(model: unknown, position: { lineNumber: number; column: number }): Promise<unknown>;
      };
    },
  };
  return monaco as never;
}
