import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import {
  mapLspSignatureHelpToMonaco,
  registerLspSignatureHelpProvider,
  signatureHelpTriggerCharactersFor,
} from "./signature-help-provider";

describe("Monaco LSP signature help provider", () => {
  test("maps signature trigger characters for Tier-1 languages", () => {
    expect(signatureHelpTriggerCharactersFor("typescript")).toEqual(["(", ","]);
    expect(signatureHelpTriggerCharactersFor("python")).toEqual(["(", ","]);
    expect(signatureHelpTriggerCharactersFor("go")).toEqual(["(", ","]);
  });

  test("maps shared SignatureHelp to Monaco SignatureHelp", () => {
    expect(
      mapLspSignatureHelpToMonaco({
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
      }),
    ).toEqual({
      signatures: [
        {
          label: "fn(value: string): void",
          documentation: { value: "Calls fn." },
          parameters: [
            {
              label: [3, 16],
              documentation: { value: "Input value." },
            },
          ],
          activeParameter: 0,
        },
      ],
      activeSignature: 0,
      activeParameter: 0,
    });
  });

  test("registers provider that invokes the editor bridge", async () => {
    const monaco = createFakeMonaco();
    const model = {};
    const requests: unknown[] = [];

    registerLspSignatureHelpProvider(monaco, {
      workspaceId: "ws_signature" as WorkspaceId,
      path: "src/index.ts",
      language: "typescript",
      languageId: "typescript",
      model: model as never,
      editorApi: {
        async invoke(request) {
          requests.push(request);
          return {
            type: "lsp-signature-help/get/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            signatureHelp: {
              signatures: [{ label: "fn(): void", parameters: [] }],
              activeSignature: 0,
              activeParameter: 0,
            },
            resolvedAt: "2026-04-27T00:00:00.000Z",
          };
        },
      },
    });

    expect(monaco.signatureProvider?.signatureHelpTriggerCharacters).toEqual(["(", ","]);
    const result = await monaco.signatureProvider?.provideSignatureHelp(
      model,
      { lineNumber: 2, column: 8 },
      {},
      {
        triggerKind: monaco.languages.SignatureHelpTriggerKind.TriggerCharacter,
        triggerCharacter: "(",
        isRetrigger: false,
      },
    );

    expect(requests).toEqual([
      {
        type: "lsp-signature-help/get",
        workspaceId: "ws_signature",
        path: "src/index.ts",
        language: "typescript",
        position: { line: 1, character: 7 },
        triggerKind: "trigger-character",
        triggerCharacter: "(",
        isRetrigger: false,
        activeSignatureHelp: null,
      },
    ]);
    expect(result).toMatchObject({
      value: {
        signatures: [{ label: "fn(): void", parameters: [] }],
        activeSignature: 0,
        activeParameter: 0,
      },
    });
  });
});

function createFakeMonaco() {
  const monaco = {
    languages: {
      SignatureHelpTriggerKind: {
        Invoke: 1,
        TriggerCharacter: 2,
        ContentChange: 3,
      },
      registerSignatureHelpProvider(_languageId: string, provider: unknown) {
        monaco.signatureProvider = provider as typeof monaco.signatureProvider;
        return { dispose() {} };
      },
    },
    signatureProvider: null as null | {
      signatureHelpTriggerCharacters: string[];
      provideSignatureHelp(
        model: unknown,
        position: { lineNumber: number; column: number },
        token: unknown,
        context: unknown,
      ): Promise<unknown>;
    },
  };
  return monaco as never;
}
