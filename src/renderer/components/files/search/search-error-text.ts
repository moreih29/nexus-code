import type { TFunction } from "i18next";

/**
 * Lead of the agent's message for a pattern its regexp engine rejects, e.g.
 * `Invalid search pattern "(?=x)": error parsing regexp: invalid or
 * unsupported Perl syntax: `(?=``. JavaScript accepts syntax the agent's
 * engine does not (lookaround, backreferences), so such patterns pass the
 * input check and fail only when searched.
 */
const AGENT_PATTERN_LEAD = /^Invalid search pattern "(?:[^"\\]|\\.)*": (?:error parsing regexp: )?/;

/**
 * Text for a failed search: a localized line for a pattern the agent cannot
 * use, keeping the engine's reason, and the generic failure line when there
 * is no message.
 */
export function searchErrorText(message: string | undefined, t: TFunction): string {
  if (!message) return t("search.state.error");
  const lead = AGENT_PATTERN_LEAD.exec(message);
  if (lead) return t("search.unsupportedRegex", { error: message.slice(lead[0].length) });
  return message;
}
