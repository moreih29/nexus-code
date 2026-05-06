import { describe, expect, test } from "bun:test";
import {
  CodeActionSchema,
  DiagnosticSchema,
  DocumentHighlightKindSchema,
  DocumentHighlightSchema,
  DocumentSymbolSchema,
  HoverResultSchema,
  LocationLinkSchema,
  LocationSchema,
  MarkupContentSchema,
  PositionSchema,
  RangeSchema,
  ReferencesArgsSchema,
  ServerCapabilitiesSchema,
  SymbolInformationSchema,
  TextDocumentContentChangeEventSchema,
  TextEditSchema,
  WorkspaceEditSchema,
  WorkspaceSymbolArgsSchema,
} from "../../../src/shared/lsp-types";

const range = {
  start: { line: 1, character: 2 },
  end: { line: 1, character: 8 },
};

function roundTrip<T>(schema: { parse: (value: unknown) => T }, value: unknown): T {
  const parsed = schema.parse(value);
  return schema.parse(JSON.parse(JSON.stringify(parsed)));
}

describe("LSP zod types", () => {
  test("round-trips Position and Range", () => {
    expect(roundTrip(PositionSchema, { line: 0, character: 0 })).toEqual({
      line: 0,
      character: 0,
    });
    expect(roundTrip(RangeSchema, range)).toEqual(range);
  });

  test("round-trips Location and LocationLink", () => {
    expect(roundTrip(LocationSchema, { uri: "file:///workspace/main.py", range })).toEqual({
      uri: "file:///workspace/main.py",
      range,
    });
    expect(
      roundTrip(LocationLinkSchema, {
        targetUri: "file:///workspace/target.py",
        targetRange: range,
        targetSelectionRange: range,
        originSelectionRange: range,
      }),
    ).toEqual({
      targetUri: "file:///workspace/target.py",
      targetRange: range,
      targetSelectionRange: range,
      originSelectionRange: range,
    });
  });

  test("parses MarkupContent and hover response ranges", () => {
    expect(
      roundTrip(MarkupContentSchema, {
        kind: "markdown",
        value: "```python\nprint('hi')\n```",
      }),
    ).toEqual({
      kind: "markdown",
      value: "```python\nprint('hi')\n```",
    });
    expect(
      roundTrip(HoverResultSchema, { contents: { kind: "plaintext", value: "plain" }, range }),
    ).toEqual({
      contents: { kind: "plaintext", value: "plain" },
      range,
    });
  });

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

  test("round-trips SymbolInformation and nested DocumentSymbol", () => {
    expect(
      roundTrip(SymbolInformationSchema, {
        name: "main",
        kind: 12,
        location: { uri: "file:///workspace/main.py", range },
        containerName: "module",
      }),
    ).toEqual({
      name: "main",
      kind: 12,
      location: { uri: "file:///workspace/main.py", range },
      containerName: "module",
    });

    expect(
      roundTrip(DocumentSymbolSchema, {
        name: "Outer",
        kind: 5,
        range,
        selectionRange: range,
        children: [{ name: "method", kind: 6, range, selectionRange: range }],
      }),
    ).toEqual({
      name: "Outer",
      kind: 5,
      range,
      selectionRange: range,
      children: [{ name: "method", kind: 6, range, selectionRange: range }],
    });
  });

  test("parses ReferencesArgsSchema with explicit includeDeclaration", () => {
    expect(
      roundTrip(ReferencesArgsSchema, {
        uri: "file:///workspace/main.py",
        line: 3,
        character: 7,
        includeDeclaration: true,
      }),
    ).toEqual({
      uri: "file:///workspace/main.py",
      line: 3,
      character: 7,
      includeDeclaration: true,
    });
    expect(
      roundTrip(ReferencesArgsSchema, {
        uri: "file:///workspace/main.py",
        line: 3,
        character: 7,
        includeDeclaration: false,
      }),
    ).toEqual({
      uri: "file:///workspace/main.py",
      line: 3,
      character: 7,
      includeDeclaration: false,
    });
    expect(
      ReferencesArgsSchema.safeParse({
        uri: "file:///workspace/main.py",
        line: 3,
        character: 7,
      }).success,
    ).toBe(false);
  });

  test("parses DocumentHighlightSchema kind enum and optional kind", () => {
    expect(DocumentHighlightKindSchema.safeParse(1).success).toBe(true);
    expect(DocumentHighlightKindSchema.safeParse(2).success).toBe(true);
    expect(DocumentHighlightKindSchema.safeParse(3).success).toBe(true);
    expect(roundTrip(DocumentHighlightSchema, { range, kind: 1 })).toEqual({ range, kind: 1 });
    expect(roundTrip(DocumentHighlightSchema, { range, kind: 2 })).toEqual({ range, kind: 2 });
    expect(roundTrip(DocumentHighlightSchema, { range, kind: 3 })).toEqual({ range, kind: 3 });
    expect(roundTrip(DocumentHighlightSchema, { range })).toEqual({ range });
    expect(DocumentHighlightSchema.safeParse({ range, kind: 4 }).success).toBe(false);
  });

  test("parses WorkspaceSymbolArgsSchema", () => {
    expect(
      roundTrip(WorkspaceSymbolArgsSchema, {
        workspaceId: "ws-1",
        query: "Controller",
      }),
    ).toEqual({
      workspaceId: "ws-1",
      query: "Controller",
    });
    expect(WorkspaceSymbolArgsSchema.safeParse({ workspaceId: "ws-1" }).success).toBe(false);
  });

  test("round-trips full Diagnostic fields", () => {
    expect(
      roundTrip(DiagnosticSchema, {
        range,
        severity: 2,
        code: "reportUnusedImport",
        codeDescription: { href: "https://example.invalid/rule" },
        source: "Pyright",
        message: "Import is not accessed",
        tags: [1],
        relatedInformation: [
          {
            location: { uri: "file:///workspace/other.py", range },
            message: "Related location",
          },
        ],
        data: { rule: "reportUnusedImport" },
      }),
    ).toEqual({
      range,
      severity: 2,
      code: "reportUnusedImport",
      codeDescription: { href: "https://example.invalid/rule" },
      source: "Pyright",
      message: "Import is not accessed",
      tags: [1],
      relatedInformation: [
        {
          location: { uri: "file:///workspace/other.py", range },
          message: "Related location",
        },
      ],
      data: { rule: "reportUnusedImport" },
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
