/**
 * LSP completion items as Monaco shows them: the server's text, range,
 * snippet, sort order and documentation carry over, and a range Monaco
 * cannot use falls back to the word before the cursor.
 */

import { expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import {
  lspCompletionItemDetails,
  lspCompletionItemToMonaco,
} from "../../../../../src/renderer/services/editor/lsp/monaco-converters";

const monaco = {
  languages: {
    CompletionItemKind: { Text: 18, Function: 1 },
    CompletionItemTag: { Deprecated: 1 },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
  },
} as unknown as typeof Monaco;

// Cursor after "app." on line 3 (Monaco counts from 1).
const POSITION = { lineNumber: 3, column: 5 };
const WORD = { startLineNumber: 3, endLineNumber: 3, startColumn: 5, endColumn: 5 };
const lspRange = (start: number, end: number, line = 2) => ({
  start: { line, character: start },
  end: { line, character: end },
});

test("a snippet item keeps its text, range, order and documentation", () => {
  const item = lspCompletionItemToMonaco(
    monaco,
    {
      label: "readFile",
      labelDetails: { description: "node:fs" },
      kind: 3,
      detail: "(path: string) => string",
      documentation: { kind: "markdown", value: "Reads **a file**." },
      sortText: "11",
      filterText: "readFile",
      insertTextFormat: 2,
      textEdit: { range: lspRange(4, 4), newText: "readFile($1)" },
      commitCharacters: ["("],
    },
    POSITION,
    WORD,
  );

  expect(item).toMatchObject({
    label: { label: "readFile", description: "node:fs" },
    kind: 1,
    detail: "(path: string) => string",
    documentation: { value: "Reads **a file**." },
    sortText: "11",
    filterText: "readFile",
    insertText: "readFile($1)",
    insertTextRules: 4,
    range: { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 5 },
    commitCharacters: ["("],
  });
});

test("a plain item inserts its insertText, else its label, over the word", () => {
  const plain = lspCompletionItemToMonaco(
    monaco,
    { label: "map", insertText: "map" },
    POSITION,
    WORD,
  );
  const bare = lspCompletionItemToMonaco(monaco, { label: "filter" }, POSITION, WORD);

  expect(plain.insertText).toBe("map");
  expect(plain.insertTextRules).toBeUndefined();
  expect(plain.range).toBe(WORD);
  expect(bare.insertText).toBe("filter");
});

test("an insert/replace edit keeps both ranges", () => {
  const item = lspCompletionItemToMonaco(
    monaco,
    {
      label: "length",
      textEdit: { newText: "length", insert: lspRange(4, 4), replace: lspRange(4, 7) },
    },
    POSITION,
    WORD,
  );

  expect(item.range).toEqual({
    insert: { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 5 },
    replace: { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 8 },
  });
});

test("a range off the cursor's line falls back to the word", () => {
  const item = lspCompletionItemToMonaco(
    monaco,
    { label: "x", textEdit: { range: lspRange(0, 1, 0), newText: "x" } },
    POSITION,
    WORD,
  );

  expect(item.range).toBe(WORD);
});

test("deprecated items are struck through; plain-text docs stay text", () => {
  const tagged = lspCompletionItemToMonaco(monaco, { label: "a", tags: [1] }, POSITION, WORD);
  const flagged = lspCompletionItemToMonaco(
    monaco,
    { label: "b", deprecated: true },
    POSITION,
    WORD,
  );
  const docs = lspCompletionItemDetails({
    label: "c",
    documentation: { kind: "plaintext", value: "*not* markdown" },
  });

  expect(tagged.tags).toEqual([1]);
  expect(flagged.tags).toEqual([1]);
  expect(docs.documentation).toBe("*not* markdown");
});

test("an auto-import's edits become Monaco edits", () => {
  const details = lspCompletionItemDetails({
    label: "readFile",
    additionalTextEdits: [
      { range: lspRange(0, 0, 0), newText: 'import { readFile } from "node:fs";\n' },
    ],
  });

  expect(details.additionalTextEdits).toEqual([
    {
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      text: 'import { readFile } from "node:fs";\n',
    },
  ]);
});

test("only editor commands carry over", () => {
  const editor = lspCompletionItemToMonaco(
    monaco,
    { label: "f", command: { title: "", command: "editor.action.triggerParameterHints" } },
    POSITION,
    WORD,
  );
  const server = lspCompletionItemToMonaco(
    monaco,
    { label: "g", command: { title: "", command: "_typescript.applyCompletionCodeAction" } },
    POSITION,
    WORD,
  );

  expect(editor.command).toEqual({ id: "editor.action.triggerParameterHints", title: "" });
  expect(server.command).toBeUndefined();
});
