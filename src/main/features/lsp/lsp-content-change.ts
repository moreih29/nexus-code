// Apply LSP textDocument content changes to a cached buffer. The agent
// does not store text — caching lives on the TS side so we can downgrade
// incremental updates to a "Full" payload when the server's
// textDocumentSync.change is Full but the client only sees deltas.

import type { TextDocumentContentChangeEvent } from "../../../shared/lsp";

export function reconstructMissingCache(
  contentChanges: readonly TextDocumentContentChangeEvent[],
): string | undefined {
  for (const change of contentChanges) {
    if (!("range" in change)) return change.text;
  }
  return undefined;
}

export function applyTextDocumentContentChanges(
  text: string,
  contentChanges: readonly TextDocumentContentChangeEvent[],
): string {
  let nextText = text;
  for (const change of contentChanges) {
    if (!("range" in change)) {
      nextText = change.text;
      continue;
    }

    const start = offsetAt(nextText, change.range.start);
    const end = offsetAt(nextText, change.range.end);
    nextText = `${nextText.slice(0, start)}${change.text}${nextText.slice(end)}`;
  }
  return nextText;
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

  return Math.min(index + position.character, lineEndOffset(text, index));
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
