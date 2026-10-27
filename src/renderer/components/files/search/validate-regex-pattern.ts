/**
 * Pure helper — validates a search pattern as a JavaScript RegExp.
 *
 * Contract:
 *   - When `isRegExp` is false the pattern is treated as a literal string and
 *     is always considered valid (returns `{ valid: true }`).
 *   - When `isRegExp` is true the pattern is compiled via `new RegExp(pattern)`.
 *     A successful compile returns `{ valid: true }`; a SyntaxError returns
 *     `{ valid: false, error: <reason> }`.
 *
 * The reason is the engine's message without its "Invalid regular expression:
 * /<pattern>/: " lead — e.g. "Unterminated character class" — since callers
 * display it inside their own "Invalid regular expression: <error>" wrapper
 * next to the pattern the user is typing.
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
    return {
      valid: false,
      error: regexErrorReason(err instanceof Error ? err.message : String(err)),
    };
  }
}

/**
 * Lead of an engine's SyntaxError message: V8 writes "Invalid regular
 * expression: /<source>/<flags>: <reason>", JavaScriptCore "Invalid regular
 * expression: <reason>".
 */
const ENGINE_MESSAGE_LEAD = /^Invalid regular expression: (?:\/[\s\S]*\/[a-z]*: )?/;

/** The reason of a RegExp SyntaxError message, without the engine's lead. */
export function regexErrorReason(message: string): string {
  return message.replace(ENGINE_MESSAGE_LEAD, "");
}
