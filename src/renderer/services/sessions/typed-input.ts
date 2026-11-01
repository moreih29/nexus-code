/**
 * Text the sessions tab types into an agent's terminal: keys, not a paste.
 *
 * Claude Code takes a paste over three lines or 800 characters as text the
 * user pasted from somewhere else, and tells the model so. What the user
 * writes in the sessions tab is their own words, so it goes as typed keys:
 * Ctrl+J (a line feed) between lines, which Claude Code and Codex both take
 * as a new line without sending, and the text in short pieces, so no single
 * read looks like a paste.
 */

/** Characters in one piece of typed text. */
const CHUNK_CHARS = 64;

/** Ctrl+J: a new line in Claude Code's and Codex's input, not Enter. */
export const NEWLINE_KEY = "\n";

/**
 * The pieces to type for `text`, in order: each line in pieces of at most
 * CHUNK_CHARS characters, with NEWLINE_KEY between lines. A tab becomes
 * spaces, as Tab is a key both agents act on, and other control characters
 * are dropped so the text cannot press keys of its own.
 */
export function typedChunks(text: string): string[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what is removed
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
    .split("\n");
  const chunks: string[] = [];
  lines.forEach((line, index) => {
    if (index > 0) chunks.push(NEWLINE_KEY);
    const chars = Array.from(line);
    for (let start = 0; start < chars.length; start += CHUNK_CHARS) {
      chunks.push(chars.slice(start, start + CHUNK_CHARS).join(""));
    }
  });
  return chunks;
}
