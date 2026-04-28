import { describe, expect, test } from "bun:test";

import type { LspSignatureHelpRequest } from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  buildSignatureHelpParams,
  LspSignatureHelpCapability,
  mapSignatureHelpResponse,
} from "./signature-help";

const workspaceId = "ws_lsp_signature" as WorkspaceId;
const request: LspSignatureHelpRequest = {
  type: "lsp-signature-help/get",
  workspaceId,
  path: "src/index.ts",
  language: "typescript",
  position: { line: 2, character: 10 },
  triggerKind: "trigger-character",
  triggerCharacter: "(",
  isRetrigger: false,
};

describe("LspSignatureHelpCapability", () => {
  test("builds signatureHelp params with trigger context", () => {
    expect(buildSignatureHelpParams(request, "file:///repo/src/index.ts")).toEqual({
      textDocument: { uri: "file:///repo/src/index.ts" },
      position: { line: 2, character: 10 },
      context: {
        triggerKind: 2,
        triggerCharacter: "(",
        isRetrigger: false,
        activeSignatureHelp: undefined,
      },
    });
  });

  test("maps SignatureHelp responses", () => {
    expect(
      mapSignatureHelpResponse({
        signatures: [
          {
            label: "fn(value: string): void",
            documentation: { kind: "markdown", value: "Calls fn." },
            parameters: [
              {
                label: [3, 16],
                documentation: "Input value.",
              },
            ],
            activeParameter: 0,
          },
        ],
        activeSignature: 0,
        activeParameter: 0,
      }),
    ).toEqual({
      signatures: [
        {
          label: "fn(value: string): void",
          documentation: "Calls fn.",
          parameters: [
            {
              label: [3, 16],
              documentation: "Input value.",
            },
          ],
          activeParameter: 0,
        },
      ],
      activeSignature: 0,
      activeParameter: 0,
    });
  });

  test("returns timestamped bridge result", async () => {
    const capability = new LspSignatureHelpCapability({
      now: () => new Date("2026-04-27T00:00:00.000Z"),
    });
    const result = await capability.signatureHelp({
      request,
      path: "src/index.ts",
      uri: "file:///repo/src/index.ts",
      async sendRequest() {
        return {
          signatures: [{ label: "fn(): void", parameters: [] }],
          activeSignature: 0,
          activeParameter: 0,
        };
      },
    });

    expect(result).toEqual({
      type: "lsp-signature-help/get/result",
      workspaceId,
      path: "src/index.ts",
      language: "typescript",
      signatureHelp: {
        signatures: [
          {
            label: "fn(): void",
            documentation: null,
            parameters: [],
            activeParameter: null,
          },
        ],
        activeSignature: 0,
        activeParameter: 0,
      },
      resolvedAt: "2026-04-27T00:00:00.000Z",
    });
  });
});
