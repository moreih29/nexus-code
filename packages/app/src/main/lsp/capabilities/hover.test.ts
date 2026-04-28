import { describe, expect, test } from "bun:test";

import type { LspHoverRequest } from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import { buildHoverParams, LspHoverCapability, mapHoverResponse } from "./hover";

const workspaceId = "ws_lsp_hover" as WorkspaceId;
const request: LspHoverRequest = {
  type: "lsp-hover/read",
  workspaceId,
  path: "src/index.ts",
  language: "typescript",
  position: { line: 1, character: 5 },
};

describe("LspHoverCapability", () => {
  test("builds textDocument/hover params from the editor bridge request", () => {
    expect(buildHoverParams(request, "file:///workspace/src/index.ts")).toEqual({
      textDocument: { uri: "file:///workspace/src/index.ts" },
      position: { line: 1, character: 5 },
    });
  });

  test("maps MarkupContent markdown and plaintext hovers", () => {
    expect(
      mapHoverResponse({
        contents: { kind: "markdown", value: "**value**: number" },
        range: {
          start: { line: 1, character: 2 },
          end: { line: 1, character: 7 },
        },
      }),
    ).toEqual({
      contents: [{ kind: "markdown", value: "**value**: number" }],
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 7 },
      },
    });

    expect(
      mapHoverResponse({
        contents: { kind: "plaintext", value: "literal **not markdown**" },
      }).contents,
    ).toEqual([{ kind: "plaintext", value: "literal **not markdown**" }]);
  });

  test("preserves Korean and unicode hover content through LSP response mapping", () => {
    const koreanMarkdown = "### 값 설명\n\n한국어 hover 문서 ✅";
    const koreanPlaintext = "한국어 일반 텍스트 hover 설명 ✅";

    expect(
      mapHoverResponse({
        contents: { kind: "markdown", value: koreanMarkdown },
      }).contents,
    ).toEqual([{ kind: "markdown", value: koreanMarkdown }]);
    expect(
      mapHoverResponse({
        contents: { kind: "plaintext", value: koreanPlaintext },
      }).contents,
    ).toEqual([{ kind: "plaintext", value: koreanPlaintext }]);
  });

  test("maps MarkedString string and language-value arrays", () => {
    expect(
      mapHoverResponse({
        contents: [
          "A markdown string.",
          { language: "ts", value: "const value = 1;" },
        ],
      }).contents,
    ).toEqual([
      { kind: "markdown", value: "A markdown string." },
      { kind: "markdown", value: "```ts\nconst value = 1;\n```" },
    ]);
  });

  test("returns a timestamped bridge result through the request callback", async () => {
    const capability = new LspHoverCapability({
      now: () => new Date("2026-04-27T00:00:00.000Z"),
    });
    const sentParams: unknown[] = [];

    const result = await capability.hover({
      request,
      path: "src/index.ts",
      uri: "file:///workspace/src/index.ts",
      async sendRequest(params) {
        sentParams.push(params);
        return { contents: { kind: "plaintext", value: "value: number" } };
      },
    });

    expect(sentParams).toEqual([buildHoverParams(request, "file:///workspace/src/index.ts")]);
    expect(result).toEqual({
      type: "lsp-hover/read/result",
      workspaceId,
      path: "src/index.ts",
      language: "typescript",
      contents: [{ kind: "plaintext", value: "value: number" }],
      range: null,
      readAt: "2026-04-27T00:00:00.000Z",
    });
  });
});
