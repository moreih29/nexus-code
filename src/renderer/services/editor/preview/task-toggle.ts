// GFM task-list checkbox toggling for the markdown preview.
//
// The preview renders task items (`- [ ]`) as live checkboxes; clicking one
// rewrites the corresponding source line and pushes it back into the Monaco
// model. The line-level transform lives here so it can be unit-tested without
// an Electron / Monaco host.

/**
 * Flip a GFM task-list marker on a single source line: `[ ]` ⇄ `[x]`.
 *
 * Recognises the same item shapes as remark-gfm:
 *   - unordered markers `-`, `*`, `+`
 *   - ordered markers `1.`, `1)`
 *   - any leading indentation (nested lists)
 *
 * Only the FIRST `[ ]`/`[x]` after the list marker is touched, so checkbox
 * glyphs appearing later in the item text are left alone. Returns the
 * rewritten line, or null when the line is not a task item — a no-op safety
 * net in case the model changed between render and click.
 */
export function toggleTaskMarker(line: string): string | null {
  const m = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/.exec(line);
  if (!m) return null;
  const checked = m[2] !== " ";
  const replacement = checked ? "[ ]" : "[x]";
  const at = m[1].length;
  return line.slice(0, at) + replacement + line.slice(at + 3);
}
