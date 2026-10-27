/**
 * relativeTime — compact, translated labels for git rows.
 */
import { afterEach, describe, expect, it } from "bun:test";
import i18next from "i18next";
import { relativeTime } from "../../../../../../../src/renderer/components/files/git/utils/relative-time";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

afterEach(async () => {
  await i18next.changeLanguage("en");
});

describe("relativeTime", () => {
  it("labels each range in English", () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 5 * MINUTE, NOW)).toBe("5m ago");
    expect(relativeTime(NOW - 3 * 60 * MINUTE, NOW)).toBe("3h ago");
    expect(relativeTime(NOW - 2 * DAY, NOW)).toBe("2d ago");
    expect(relativeTime(NOW - 120 * DAY, NOW)).toBe("4mo ago");
    expect(relativeTime(NOW - 400 * DAY, NOW)).toBe("1y ago");
    expect(relativeTime("not a date", NOW)).toBe("unknown time");
  });

  it("accepts an ISO date", () => {
    expect(relativeTime("2026-10-27T11:00:00Z", NOW)).toBe("1h ago");
  });

  it("follows the UI language", async () => {
    await i18next.changeLanguage("ko");

    expect(relativeTime(NOW - 30_000, NOW)).toBe("방금");
    expect(relativeTime(NOW - 5 * MINUTE, NOW)).toBe("5분 전");
    expect(relativeTime(NOW - 120 * DAY, NOW)).toBe("4개월 전");
  });
});
