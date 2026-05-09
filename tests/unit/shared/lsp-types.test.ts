import { describe, expect, test } from "bun:test";
import {
  CodeActionSchema,
  DiagnosticSchema,
  MarkupContentSchema,
  PositionSchema,
  RangeSchema,
  ServerCapabilitiesSchema,
  TextDocumentContentChangeEventSchema,
  TextEditSchema,
  WorkspaceEditSchema,
} from "../../../src/shared/lsp";

const range = {
  start: { line: 1, character: 2 },
  end: { line: 1, character: 8 },
};

function roundTrip<T>(schema: { parse: (value: unknown) => T }, value: unknown): T {
  const parsed = schema.parse(value);
  return schema.parse(JSON.parse(JSON.stringify(parsed)));
}

describe("LSP zod types", () => {
  test("round-trips TextEdit and WorkspaceEdit changes", () => {
    expect(
      roundTrip(TextDocumentContentChangeEventSchema, {
        range,
        rangeLength: 6,
        text: "change",
      }),
    ).toEqual({
      range,
      rangeLength: 6,
      text: "change",
    });
    expect(roundTrip(TextDocumentContentChangeEventSchema, { text: "full document" })).toEqual({
      text: "full document",
    });
    expect(roundTrip(TextEditSchema, { range, newText: "replacement" })).toEqual({
      range,
      newText: "replacement",
    });
    expect(
      roundTrip(WorkspaceEditSchema, {
        changes: {
          "file:///workspace/main.py": [{ range, newText: "x" }],
        },
      }),
    ).toEqual({
      changes: {
        "file:///workspace/main.py": [{ range, newText: "x" }],
      },
    });
  });

  test("round-trips CodeAction with WorkspaceEdit", () => {
    expect(
      roundTrip(CodeActionSchema, {
        title: "Apply fix",
        kind: "quickfix",
        diagnostics: [{ range, severity: 1, message: "Problem" }],
        edit: {
          changes: {
            "file:///workspace/main.py": [{ range, newText: "fixed" }],
          },
        },
        isPreferred: true,
      }),
    ).toEqual({
      title: "Apply fix",
      kind: "quickfix",
      diagnostics: [{ range, severity: 1, message: "Problem" }],
      edit: {
        changes: {
          "file:///workspace/main.py": [{ range, newText: "fixed" }],
        },
      },
      isPreferred: true,
    });
  });

  test("round-trips passthrough ServerCapabilities fields", () => {
    expect(
      roundTrip(ServerCapabilitiesSchema, {
        hoverProvider: true,
        completionProvider: { triggerCharacters: ["."] },
        experimentalProvider: { custom: "value" },
      }),
    ).toEqual({
      hoverProvider: true,
      completionProvider: { triggerCharacters: ["."] },
      experimentalProvider: { custom: "value" },
    });
  });

  test("rejects invalid LSP enum values", () => {
    expect(PositionSchema.safeParse({ line: -1, character: 0 }).success).toBe(false);
    expect(MarkupContentSchema.safeParse({ kind: "html", value: "<b>x</b>" }).success).toBe(false);
    expect(DiagnosticSchema.safeParse({ range, severity: 9, message: "bad" }).success).toBe(false);
  });
});
