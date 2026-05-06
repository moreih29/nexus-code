/** Contract: ipcContract.lsp */
import { describe, expect, test } from "bun:test";
import { ipcContract } from "../../../../src/shared/ipc-contract";

const range = {
  start: { line: 5, character: 2 },
  end: { line: 5, character: 9 },
};

describe("ipcContract.lsp.call.didOpen", () => {
  const schema = ipcContract.lsp.call.didOpen.args;

  test("accepts document payload with workspace root", () => {
    const result = schema.safeParse({
      workspaceId: "123e4567-e89b-42d3-a456-426614174000",
      workspaceRoot: "/workspace",
      uri: "file:///workspace/src/index.ts",
      languageId: "typescript",
      version: 1,
      text: "const value = 1;\n",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing workspace root", () => {
    const result = schema.safeParse({
      workspaceId: "123e4567-e89b-42d3-a456-426614174000",
      uri: "file:///workspace/src/index.ts",
      languageId: "typescript",
      version: 1,
      text: "const value = 1;\n",
    });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.lsp.call.didChange", () => {
  const schema = ipcContract.lsp.call.didChange.args;

  test("accepts incremental contentChanges array", () => {
    const result = schema.safeParse({
      uri: "file:///workspace/src/index.ts",
      version: 2,
      contentChanges: [
        {
          range,
          rangeLength: 7,
          text: "updated",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("rejects legacy full text payload", () => {
    const result = schema.safeParse({
      uri: "file:///workspace/src/index.ts",
      version: 2,
      text: "const value = 2;\n",
    });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.lsp.call.didSave", () => {
  const schema = ipcContract.lsp.call.didSave.args;

  test("accepts a save notification with optional text", () => {
    expect(
      schema.safeParse({
        uri: "file:///workspace/src/index.ts",
        text: "const value = 1;\n",
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ uri: "file:///workspace/src/index.ts" }).success).toBe(true);
  });

  test("rejects missing uri", () => {
    const result = schema.safeParse({ text: "const value = 1;\n" });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.lsp.call.hover", () => {
  const schema = ipcContract.lsp.call.hover.args;

  test("accepts valid hover position", () => {
    const result = schema.safeParse({ uri: "file:///src/index.ts", line: 10, character: 5 });
    expect(result.success).toBe(true);
  });

  test("rejects missing character", () => {
    const result = schema.safeParse({ uri: "file:///src/index.ts", line: 10 });
    expect(result.success).toBe(false);
  });

  test("result accepts null (no hover info)", () => {
    const result = ipcContract.lsp.call.hover.result.safeParse(null);
    expect(result.success).toBe(true);
  });

  test("result accepts object with contents", () => {
    const result = ipcContract.lsp.call.hover.result.safeParse({ contents: "string type" });
    expect(result.success).toBe(true);
  });

  test("result accepts MarkupContent with range", () => {
    const result = ipcContract.lsp.call.hover.result.safeParse({
      contents: { kind: "markdown", value: "```ts\nconst value = 1;\n```" },
      range,
    });
    expect(result.success).toBe(true);
  });
});

describe("ipcContract.lsp.call.definition", () => {
  const schema = ipcContract.lsp.call.definition.args;

  test("accepts valid definition position", () => {
    const result = schema.safeParse({ uri: "file:///src/index.ts", line: 0, character: 0 });
    expect(result.success).toBe(true);
  });

  test("rejects non-integer line", () => {
    const result = schema.safeParse({ uri: "file:///src/index.ts", line: 1.5, character: 0 });
    expect(result.success).toBe(false);
  });

  test("result accepts LSP Location ranges", () => {
    const result = ipcContract.lsp.call.definition.result.safeParse([
      { uri: "file:///src/index.ts", range },
    ]);
    expect(result.success).toBe(true);
  });
});

describe("ipcContract.lsp.call.completion", () => {
  const schema = ipcContract.lsp.call.completion.args;

  test("accepts valid completion position", () => {
    const result = schema.safeParse({ uri: "file:///src/foo.ts", line: 3, character: 12 });
    expect(result.success).toBe(true);
  });
});

describe("ipcContract.lsp.call.references", () => {
  const schema = ipcContract.lsp.call.references.args;

  test("accepts valid reference position with includeDeclaration", () => {
    const result = schema.safeParse({
      uri: "file:///src/foo.ts",
      line: 3,
      character: 12,
      includeDeclaration: false,
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing includeDeclaration", () => {
    const result = schema.safeParse({ uri: "file:///src/foo.ts", line: 3, character: 12 });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.lsp.call.documentHighlight", () => {
  const schema = ipcContract.lsp.call.documentHighlight.args;

  test("accepts valid document highlight position", () => {
    const result = schema.safeParse({ uri: "file:///src/foo.ts", line: 3, character: 12 });
    expect(result.success).toBe(true);
  });

  test("result accepts document highlight ranges with optional kind", () => {
    const result = ipcContract.lsp.call.documentHighlight.result.safeParse([
      { range, kind: 1 },
      { range },
    ]);
    expect(result.success).toBe(true);
  });
});

describe("ipcContract.lsp.call.documentSymbol", () => {
  const schema = ipcContract.lsp.call.documentSymbol.args;

  test("accepts document uri args", () => {
    const result = schema.safeParse({ uri: "file:///src/foo.ts" });
    expect(result.success).toBe(true);
  });

  test("result accepts hierarchical document symbols", () => {
    const result = ipcContract.lsp.call.documentSymbol.result.safeParse([
      {
        name: "ClassName",
        kind: 5,
        range,
        selectionRange: range,
        children: [{ name: "method", kind: 6, range, selectionRange: range }],
      },
    ]);
    expect(result.success).toBe(true);
  });

  test("result rejects flat SymbolInformation", () => {
    const result = ipcContract.lsp.call.documentSymbol.result.safeParse([
      {
        name: "flat",
        kind: 12,
        location: { uri: "file:///src/foo.ts", range },
      },
    ]);
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.lsp.call.workspaceSymbol", () => {
  const schema = ipcContract.lsp.call.workspaceSymbol.args;

  test("accepts workspace symbol query args", () => {
    const result = schema.safeParse({ workspaceId: "ws-1", query: "ClassName" });
    expect(result.success).toBe(true);
  });

  test("rejects missing query", () => {
    const result = schema.safeParse({ workspaceId: "ws-1" });
    expect(result.success).toBe(false);
  });

  test("result accepts symbol information with locations", () => {
    const result = ipcContract.lsp.call.workspaceSymbol.result.safeParse([
      {
        name: "ClassName",
        kind: 5,
        location: { uri: "file:///src/foo.ts", range },
        containerName: "module",
      },
    ]);
    expect(result.success).toBe(true);
  });
});

describe("ipcContract.lsp.call.didClose", () => {
  const schema = ipcContract.lsp.call.didClose.args;

  test("accepts a document uri", () => {
    const result = schema.safeParse({ uri: "file:///src/index.ts" });
    expect(result.success).toBe(true);
  });

  test("rejects missing uri", () => {
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.lsp.call.applyEditResult", () => {
  const schema = ipcContract.lsp.call.applyEditResult.args;

  test("accepts an applyEdit response payload", () => {
    const result = schema.safeParse({
      requestId: "apply-edit-1",
      result: { applied: true },
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing applied boolean", () => {
    const result = schema.safeParse({
      requestId: "apply-edit-1",
      result: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.lsp.listen.diagnostics", () => {
  const schema = ipcContract.lsp.listen.diagnostics.args;

  test("accepts valid diagnostics payload", () => {
    const result = schema.safeParse({
      uri: "file:///src/index.ts",
      diagnostics: [
        {
          range,
          message: "Type error",
          severity: 1,
          code: "reportGeneralTypeIssues",
          codeDescription: { href: "https://example.invalid/rule" },
          source: "Pyright",
          tags: [2],
          relatedInformation: [
            {
              location: { uri: "file:///src/other.ts", range },
              message: "Related type",
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts empty diagnostics array", () => {
    const result = schema.safeParse({ uri: "file:///src/index.ts", diagnostics: [] });
    expect(result.success).toBe(true);
  });

  test("rejects missing uri", () => {
    const result = schema.safeParse({ diagnostics: [] });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.lsp.listen.applyEdit", () => {
  const schema = ipcContract.lsp.listen.applyEdit.args;

  test("accepts server-initiated applyEdit event payloads", () => {
    const result = schema.safeParse({
      requestId: "apply-edit-1",
      params: {
        label: "Apply fix",
        edit: {
          changes: {
            "file:///src/index.ts": [{ range, newText: "fixed" }],
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing edit payload", () => {
    const result = schema.safeParse({
      requestId: "apply-edit-1",
      params: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.lsp.listen.serverEvent", () => {
  const schema = ipcContract.lsp.listen.serverEvent.args;

  test("accepts server-to-client UX event payloads", () => {
    const result = schema.safeParse({
      workspaceId: "123e4567-e89b-42d3-a456-426614174000",
      languageId: "typescript",
      method: "window/logMessage",
      params: { type: 3, message: "ready" },
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown server event methods", () => {
    const result = schema.safeParse({
      workspaceId: "123e4567-e89b-42d3-a456-426614174000",
      languageId: "typescript",
      method: "workspace/symbol",
      params: {},
    });
    expect(result.success).toBe(false);
  });
});
