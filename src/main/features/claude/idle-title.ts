/** The mark Claude Code puts at the start of its title between turns. */
const IDLE_MARK = "✳";

// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC sequences start with ESC
const OSC_TITLE_START = /\x1b\][02];/g;

/** Whether the title beginning at offset has Claude's idle mark. */
export function isClaudeIdleTitle(title: string | undefined, offset = 0): boolean {
  return title?.startsWith(IDLE_MARK, offset) ?? false;
}

/** Whether output contains an idle OSC title prefix, possibly still open. */
export function showsClaudeIdleTitle(output: string): boolean {
  for (const start of output.matchAll(OSC_TITLE_START)) {
    if (isClaudeIdleTitle(output, start.index + start[0].length)) return true;
  }
  return false;
}
