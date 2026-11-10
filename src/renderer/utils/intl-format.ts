/**
 * Intl formatters, made once per locale and options. Making one is costly
 * (each `new Intl.DateTimeFormat`, and each `toLocaleString`, which makes one
 * underneath), and the chat makes them on every render: a time under each
 * message, a reset time on each meter.
 */

const dateTimes = new Map<string, Intl.DateTimeFormat>();
const relatives = new Map<string, Intl.RelativeTimeFormat>();

export function dateTimeFormat(
  locale: string,
  options: Intl.DateTimeFormatOptions = {},
): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = dateTimes.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    dateTimes.set(key, format);
  }
  return format;
}

export function relativeTimeFormat(
  locale: string,
  options: Intl.RelativeTimeFormatOptions = {},
): Intl.RelativeTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = relatives.get(key);
  if (!format) {
    format = new Intl.RelativeTimeFormat(locale, options);
    relatives.set(key, format);
  }
  return format;
}

/** What `Date#toLocaleString(locale)` says, from a kept formatter. */
export const DATE_AND_TIME: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
};

/** What `Date#toLocaleDateString(locale)` says, from a kept formatter. */
export const DATE_ONLY: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
};
