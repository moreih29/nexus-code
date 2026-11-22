import i18next from "i18next";
import { dateTimeFormat } from "../../utils/intl-format";

/** A note's time: the hour today, the day this year, else the date. */
export function noteTime(at: number, now = Date.now()): string {
  const locale = i18next.language || "en";
  const d = new Date(at);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString())
    return dateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(d);
  if (d.getFullYear() === n.getFullYear())
    return dateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(d);
  return dateTimeFormat(locale, { year: "numeric", month: "numeric", day: "numeric" }).format(d);
}
