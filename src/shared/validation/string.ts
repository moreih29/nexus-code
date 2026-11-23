import { z } from "zod";

export const UrlSchema = z.stringFormat("url", (value) => URL.canParse(value));

const dateTimeWithSeconds = z.regexes.datetime({});
const dateTimeWithoutSeconds = z.regexes.datetime({ precision: -1 });

export const DateTimeSchema = z.stringFormat(
  "datetime",
  (value) => dateTimeWithSeconds.test(value) || dateTimeWithoutSeconds.test(value),
);
