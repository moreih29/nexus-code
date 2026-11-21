import { z } from "zod";

/** Preserve URL text, including whitespace that URL parsing permits. */
export const UrlSchema = z.stringFormat("url", (value) => URL.canParse(value));

const dateTimeWithSeconds = z.regexes.datetime({});
const dateTimeWithoutSeconds = z.regexes.datetime({ precision: -1 });

/** Persisted timestamps can omit seconds. */
export const DateTimeSchema = z.stringFormat(
  "datetime",
  (value) => dateTimeWithSeconds.test(value) || dateTimeWithoutSeconds.test(value),
);
