import { describe, expect, test } from "bun:test";
import {
  DATE_AND_TIME,
  DATE_ONLY,
  dateTimeFormat,
  relativeTimeFormat,
} from "../../../../src/renderer/utils/intl-format";

const AT = Date.parse("2026-11-10T06:23:43Z");

describe("kept Intl formatters", () => {
  test("one formatter per locale and options, made once", () => {
    expect(dateTimeFormat("ko", { weekday: "short" })).toBe(
      dateTimeFormat("ko", { weekday: "short" }),
    );
    expect(dateTimeFormat("ko", { weekday: "short" })).not.toBe(
      dateTimeFormat("en", { weekday: "short" }),
    );
    expect(relativeTimeFormat("ko", { numeric: "auto" })).toBe(
      relativeTimeFormat("ko", { numeric: "auto" }),
    );
  });

  test("say what toLocaleString and toLocaleDateString say", () => {
    for (const locale of ["ko", "en", "ja"]) {
      expect(dateTimeFormat(locale, DATE_AND_TIME).format(AT)).toBe(
        new Date(AT).toLocaleString(locale),
      );
      expect(dateTimeFormat(locale, DATE_ONLY).format(AT)).toBe(
        new Date(AT).toLocaleDateString(locale),
      );
    }
  });
});
