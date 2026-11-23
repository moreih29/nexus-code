import { describe, expect, test } from "bun:test";
import { DATE_ONLY, dateTimeFormat } from "../../../../src/renderer/utils/intl-format";
import { commitTime, relativeTime } from "../../../../src/renderer/utils/time-format";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  test("under a minute says just now in the asked language", () => {
    expect(relativeTime(NOW - 30_000, NOW, "ko")).toBe("방금");
    expect(relativeTime(NOW, NOW, "en")).toBe("just now");
  });

  test("minutes, hours and days in Intl words", () => {
    expect(relativeTime(NOW - 5 * MINUTE, NOW, "ko")).toBe("5분 전");
    expect(relativeTime(NOW - 3 * HOUR, NOW, "en")).toBe("3 hours ago");
    expect(relativeTime(NOW - 2 * DAY, NOW, "ko")).toBe("그저께");
  });

  test("a week or more shows month and day, with the year only for another year", () => {
    expect(relativeTime(NOW - 8 * DAY, NOW, "ko")).toBe("11월 15일");
    expect(relativeTime(NOW - 8 * DAY, NOW, "en")).toBe("Nov 15");
    const lastYear = Date.parse("2025-03-01T12:00:00Z");
    expect(relativeTime(lastYear, NOW, "ko")).toBe(
      dateTimeFormat("ko", DATE_ONLY).format(lastYear),
    );
  });

  test("takes an ISO string as git gives it, and says nothing for a bad one", () => {
    expect(relativeTime(new Date(NOW - 5 * MINUTE).toISOString(), NOW, "en")).toBe("5 minutes ago");
    expect(relativeTime("not a date", NOW, "en")).toBe("");
  });
});

describe("commitTime", () => {
  test("same text for a number and its ISO string", () => {
    expect(commitTime(NOW, "ko")).toBe(commitTime(new Date(NOW).toISOString(), "ko"));
  });

  test("keeps a string it cannot read", () => {
    expect(commitTime("soon", "en")).toBe("soon");
    expect(commitTime(Number.NaN, "en")).toBe("");
  });
});
