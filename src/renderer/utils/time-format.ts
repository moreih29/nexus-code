import i18next from "i18next";
import { DATE_ONLY, dateTimeFormat, relativeTimeFormat } from "./intl-format";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const RELATIVE: Intl.RelativeTimeFormatOptions = { numeric: "auto" };
const MONTH_DAY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
const COMMIT_TIME: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "medium" };

export type TimeValue = number | string;

function epochOf(at: TimeValue): number {
  return typeof at === "number" ? at : Date.parse(at);
}

export function relativeTime(
  at: TimeValue,
  now: number = Date.now(),
  locale: string = i18next.language,
): string {
  const epoch = epochOf(at);
  if (!Number.isFinite(epoch)) return "";
  const ago = now - epoch;
  if (ago < MINUTE_MS) return i18next.t("chat.time.now", { lng: locale });
  const format = relativeTimeFormat(locale, RELATIVE);
  if (ago < HOUR_MS) return format.format(-Math.floor(ago / MINUTE_MS), "minute");
  if (ago < DAY_MS) return format.format(-Math.floor(ago / HOUR_MS), "hour");
  if (ago < WEEK_MS) return format.format(-Math.floor(ago / DAY_MS), "day");
  const sameYear = new Date(epoch).getFullYear() === new Date(now).getFullYear();
  return dateTimeFormat(locale, sameYear ? MONTH_DAY : DATE_ONLY).format(epoch);
}

export function commitTime(at: TimeValue, locale: string = i18next.language): string {
  const epoch = epochOf(at);
  if (!Number.isFinite(epoch)) return typeof at === "string" ? at : "";
  return dateTimeFormat(locale, COMMIT_TIME).format(epoch);
}
