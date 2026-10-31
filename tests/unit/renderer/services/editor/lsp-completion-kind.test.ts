/**
 * Completion item kinds: LSP and Monaco list the same kinds in different
 * orders, so an LSP number passed through as is picks the wrong icon (a
 * method showed as a constructor, a field as a class).
 */

import { expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { lspCompletionItemKindToMonacoKind } from "../../../../../src/renderer/services/editor/lsp/monaco-converters";

// Monaco's CompletionItemKind values, as monaco-editor defines them.
const CompletionItemKind = {
  Method: 0,
  Function: 1,
  Constructor: 2,
  Field: 3,
  Variable: 4,
  Class: 5,
  Struct: 6,
  Interface: 7,
  Module: 8,
  Property: 9,
  Event: 10,
  Operator: 11,
  Unit: 12,
  Value: 13,
  Constant: 14,
  Enum: 15,
  EnumMember: 16,
  Keyword: 17,
  Text: 18,
  Color: 19,
  File: 20,
  Reference: 21,
  Customcolor: 22,
  Folder: 23,
  TypeParameter: 24,
  User: 25,
  Issue: 26,
  Snippet: 27,
};
const monaco = { languages: { CompletionItemKind } } as unknown as typeof Monaco;

test("LSP completion item kinds map to Monaco's by name", () => {
  const kind = (lsp: number | undefined) => lspCompletionItemKindToMonacoKind(monaco, lsp);
  expect(kind(2)).toBe(CompletionItemKind.Method);
  expect(kind(5)).toBe(CompletionItemKind.Field);
  expect(kind(6)).toBe(CompletionItemKind.Variable);
  expect(kind(14)).toBe(CompletionItemKind.Keyword);
  expect(kind(15)).toBe(CompletionItemKind.Snippet);
  expect(kind(25)).toBe(CompletionItemKind.TypeParameter);
});

test("a missing or unknown kind is plain text", () => {
  expect(lspCompletionItemKindToMonacoKind(monaco, undefined)).toBe(CompletionItemKind.Text);
  expect(lspCompletionItemKindToMonacoKind(monaco, 0)).toBe(CompletionItemKind.Text);
  expect(lspCompletionItemKindToMonacoKind(monaco, 26)).toBe(CompletionItemKind.Text);
});
