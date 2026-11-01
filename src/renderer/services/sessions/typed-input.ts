/**
 * Text the sessions tab types into an agent's terminal: keys, not a paste.
 *
 * Claude Code takes a paste over three lines or 800 characters as text the
 * user pasted from somewhere else, and tells the model so. What the user
 * writes in the sessions tab is their own words, so it goes as typed keys:
 * Ctrl+J (a line feed) between lines, which Claude Code and Codex both take
 * as a new line without sending, and the text in short pieces, so no single
 * read looks like a paste.
 *
 * Short pieces alone are not enough: Claude Code takes one read of over 800
 * characters as a paste, and pieces written while it is busy wait in the
 * terminal and come to it as one read. So each piece waits for the agent to
 * redraw after the one before.
 */

/** Characters in one piece of typed text. */
const CHUNK_CHARS = 64;

/**
 * How long a piece waits for the agent to show the one before. An agent that
 * does not redraw in that time gets the next piece anyway, so the text still
 * goes in, if slowly.
 */
export const ECHO_WAIT_MS = 1000;

/** A pause after each piece, so the terminal reads them one at a time. */
const CHUNK_GAP_MS = 10;

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

/** A terminal to type into. */
export interface TypingTarget {
  /** Writes `text` to the terminal as keys. */
  write(text: string): void;
  /**
   * Resolves true when the program next writes output, or false after
   * `timeoutMs` without any.
   */
  nextOutput(timeoutMs: number): Promise<boolean>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Types `text` into `target` one piece at a time, each after the agent has
 * shown the one before, so that no more than one piece waits unread.
 */
export async function typeText(target: TypingTarget, text: string): Promise<void> {
  for (const chunk of typedChunks(text)) {
    const shown = target.nextOutput(ECHO_WAIT_MS);
    target.write(chunk);
    await shown;
    await sleep(CHUNK_GAP_MS);
  }
}
