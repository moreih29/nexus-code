import i18next from "i18next";

export function relativeTime(
  isoDateOrTimestampMs: string | number,
  now: number = Date.now(),
): string {
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
