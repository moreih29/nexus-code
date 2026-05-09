/**
 * Pure helper — validates a search pattern as a JavaScript RegExp.
 *
 * Contract:
 *   - When `isRegExp` is false the pattern is treated as a literal string and
 *     is always considered valid (returns `{ valid: true }`).
 *   - When `isRegExp` is true the pattern is compiled via `new RegExp(pattern)`.
 *     A successful compile returns `{ valid: true }`; a SyntaxError returns
 *     `{ valid: false, error: <message from the Error object> }`.
 *
 * The error message is the raw `Error.message` string (or `String(err)` when
 * the thrown value is not an Error instance), matching what browsers produce
 * for invalid patterns — e.g. "Invalid regular expression: /[/: Unterminated
 * character class". Callers are responsible for displaying a human-friendly
 * wrapper (e.g. "Invalid regular expression: <error>").
 *
 * Used by SearchPanel in place of the four inline `try { new RegExp(...) }
 * catch` blocks.
 */
export function validateRegexPattern(
  pattern: string,
  isRegExp: boolean,
): { valid: true } | { valid: false; error: string } {
  if (!isRegExp) return { valid: true };
  try {
    new RegExp(pattern);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}
