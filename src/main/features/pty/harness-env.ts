// Terminal environment injector — ensures PTY sessions carry the identifiers
// that enable OSC 9 notification emission in Claude Code and similar tools.

const HARNESS_TERM_PROGRAM = "ghostty";
const HARNESS_TERM_PROGRAM_VERSION = "1.0";

/**
 * Returns a new env object that guarantees `TERM_PROGRAM` and
 * `TERM_PROGRAM_VERSION` are present. If the caller already set either key
 * the caller-supplied value wins; this function never overwrites an existing
 * value.
 *
 * The input object is never mutated.
 */
export function injectHarnessTerminalEnv(
  env: Record<string, string> | undefined,
): Record<string, string> {
  const base: Record<string, string> = {
    TERM_PROGRAM: HARNESS_TERM_PROGRAM,
    TERM_PROGRAM_VERSION: HARNESS_TERM_PROGRAM_VERSION,
  };

  if (env === undefined) {
    return base;
  }

  // Spread order: defaults first, then caller env so caller keys win.
  return { ...base, ...env };
}
