/**
 * Shared relative-time formatter for git picker rows and history lists.
 *
 * Accepts either an ISO 8601 date string or a Unix millisecond timestamp.
 * The optional `now` parameter defaults to `Date.now()` and exists for
 * deterministic unit testing. Labels come from `files:git.relativeTime`.
 */

import i18next from "i18next";

/**
 * Returns a compact human-readable relative time label.
 *
 * Examples (English):
 *   "just now"  — less than 60 seconds
 *   "5m ago"    — minutes
 *   "3h ago"    — hours
 *   "2d ago"    — days (up to 30)
 *   "4mo ago"   — months
 *   "1y ago"    — years
 *   "unknown time" — unparseable input
 */
export function relativeTime(isoDateOrTimestampMs: string | number, now: number = Date.now()): string {
  const t = i18next.t.bind(i18next);
  const then =
    typeof isoDateOrTimestampMs === "number"
      ? isoDateOrTimestampMs
      : Date.parse(isoDateOrTimestampMs);
  if (!Number.isFinite(then)) return t("files:git.relativeTime.unknown");
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return t("files:git.relativeTime.justNow");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("files:git.relativeTime.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("files:git.relativeTime.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("files:git.relativeTime.daysAgo", { count: days });
  const months = Math.floor(days / 30);
  if (months < 12) return t("files:git.relativeTime.monthsAgo", { count: months });
  return t("files:git.relativeTime.yearsAgo", { count: Math.floor(months / 12) });
}
