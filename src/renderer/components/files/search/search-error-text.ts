import type { TFunction } from "i18next";

const AGENT_PATTERN_LEAD = /^Invalid search pattern "(?:[^"\\]|\\.)*": (?:error parsing regexp: )?/;

export function unsupportedSearchPatternReason(message: string): string | undefined {
  const lead = AGENT_PATTERN_LEAD.exec(message);
  return lead ? message.slice(lead[0].length) : undefined;
}

export function searchErrorText(message: string | undefined, t: TFunction): string {
  if (!message) return t("search.state.error");
  const reason = unsupportedSearchPatternReason(message);
  if (reason !== undefined) return t("search.unsupportedRegex", { error: reason });
  return message;
}
