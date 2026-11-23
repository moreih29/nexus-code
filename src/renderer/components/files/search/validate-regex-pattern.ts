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

const ENGINE_MESSAGE_LEAD = /^Invalid regular expression: (?:\/[\s\S]*\/[a-z]*: )?/;

export function regexErrorReason(message: string): string {
  return message.replace(ENGINE_MESSAGE_LEAD, "");
}
