// Pure helpers for applying LSP text document content changes to an in-memory string.

import type {
  IncrementalTextDocumentContentChangeEvent,
  TextDocumentContentChangeEvent,
} from "../../../shared/lsp-types";

function isIncrementalChange(
  change: TextDocumentContentChangeEvent,
): change is IncrementalTextDocumentContentChangeEvent {
  return "range" in change;
}

function lineEndOffset(text: string, lineStart: number): number {
  let index = lineStart;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 10 || code === 13) break;
    index += 1;
  }
  return index;
}

function offsetAt(text: string, position: { line: number; character: number }): number {
  let index = 0;
  let line = 0;

  while (line < position.line && index < text.length) {
    const code = text.charCodeAt(index);
    index += 1;
    if (code === 13) {
      if (text.charCodeAt(index) === 10) index += 1;
      line += 1;
    } else if (code === 10) {
      line += 1;
    }
  }

  const lineEnd = lineEndOffset(text, index);
  return Math.min(index + position.character, lineEnd);
}

export function applyTextDocumentContentChanges(
  text: string,
  contentChanges: readonly TextDocumentContentChangeEvent[],
): string {
  let nextText = text;
  for (const change of contentChanges) {
    if (!isIncrementalChange(change)) {
      nextText = change.text;
      continue;
    }

    const start = offsetAt(nextText, change.range.start);
    const end = offsetAt(nextText, change.range.end);
    nextText = `${nextText.slice(0, start)}${change.text}${nextText.slice(end)}`;
  }
  return nextText;
}
