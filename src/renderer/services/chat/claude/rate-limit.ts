// Which usage-limit notice a Claude tab shows above its composer: a limit
// reached or near. Each notice can be closed for its window, and the user
// can also turn off near-limit warnings.

import type { RateLimitInfo } from "../model";

export type RateLimitNotice = "warning" | "rejected";

/** What names a notice: its chat, state, and the limit window. */
export function rateLimitKey(
  limit: RateLimitInfo,
  scope: readonly (string | number | boolean | null | undefined)[] = [],
): string {
  return JSON.stringify([...scope, limit.status, limit.rateLimitType, limit.resetsAt]);
}

export function rateLimitNotice(
  limit: RateLimitInfo | undefined,
  prefs: {
    warnings: boolean;
    dismissed: ReadonlySet<string>;
    scope?: readonly (string | number | boolean | null | undefined)[];
  },
): RateLimitNotice | null {
  if (!limit || prefs.dismissed.has(rateLimitKey(limit, prefs.scope))) return null;
  if (limit.status === "rejected") return "rejected";
  if (limit.status !== "allowed_warning") return null;
  if (!prefs.warnings) return null;
  return "warning";
}
