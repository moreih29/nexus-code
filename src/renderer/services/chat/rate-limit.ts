// Which usage-limit notice a Claude tab shows above its composer: a limit
// reached always, a limit near unless the user turned those warnings off or
// closed this one. A closed warning stays closed until its limit resets,
// when a new window's warning has another key. Pure, for the tab and tests.

import type { RateLimitInfo } from "./model";

export type RateLimitNotice = "warning" | "rejected";

/** What names one limit window: its kind and when it resets. */
export function rateLimitKey(limit: RateLimitInfo): string {
  return `${limit.rateLimitType ?? "limit"}:${limit.resetsAt ?? "?"}`;
}

export function rateLimitNotice(
  limit: RateLimitInfo | undefined,
  prefs: { warnings: boolean; dismissed: ReadonlySet<string> },
): RateLimitNotice | null {
  if (!limit) return null;
  if (limit.status === "rejected") return "rejected";
  if (limit.status !== "allowed_warning") return null;
  if (!prefs.warnings || prefs.dismissed.has(rateLimitKey(limit))) return null;
  return "warning";
}
