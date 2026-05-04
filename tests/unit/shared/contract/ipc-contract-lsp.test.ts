/** Contract: ipcContract.lsp */
import { describe, expect, test } from "bun:test";
import { ipcContract } from "../../../../src/shared/ipc-contract";

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
});

describe("ipcContract.lsp.call.completion", () => {
  const schema = ipcContract.lsp.call.completion.args;

  test("accepts valid completion position", () => {
    const result = schema.safeParse({ uri: "file:///src/foo.ts", line: 3, character: 12 });
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

describe("ipcContract.lsp.listen.diagnostics", () => {
  const schema = ipcContract.lsp.listen.diagnostics.args;

  test("accepts valid diagnostics payload", () => {
    const result = schema.safeParse({
      uri: "file:///src/index.ts",
      diagnostics: [{ line: 5, character: 2, message: "Type error", severity: 1 }],
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
