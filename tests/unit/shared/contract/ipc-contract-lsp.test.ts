/** Contract: ipcContract.lsp */
import { describe, expect, test } from "bun:test";
import { ipcContract } from "../../../../src/shared/ipc-contract";

const range = {
  start: { line: 5, character: 2 },
  end: { line: 5, character: 9 },
};

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
});

describe("ipcContract.lsp.call.hover", () => {
  test("result accepts null (no hover info)", () => {
    const result = ipcContract.lsp.call.hover.result.safeParse(null);
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

describe("ipcContract.lsp.call.documentHighlight", () => {
  test("result accepts document highlight ranges with optional kind", () => {
    const result = ipcContract.lsp.call.documentHighlight.result.safeParse([
      { range, kind: 1 },
      { range },
    ]);
    expect(result.success).toBe(true);
  });
});

describe("ipcContract.lsp.call.documentSymbol", () => {
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

describe("ipcContract.lsp.listen.diagnostics", () => {
  const schema = ipcContract.lsp.listen.diagnostics.args;

  test("accepts empty diagnostics array", () => {
    const result = schema.safeParse({ uri: "file:///src/index.ts", diagnostics: [] });
    expect(result.success).toBe(true);
  });

  test("rejects missing edit payload", () => {
    const result = ipcContract.lsp.listen.applyEdit.args.safeParse({
      requestId: "apply-edit-1",
      params: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.lsp.listen.serverEvent", () => {
  const schema = ipcContract.lsp.listen.serverEvent.args;

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
