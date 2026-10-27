/**
 * formatCommitTime — the commit tab shows a local date and time in the UI
 * language instead of a raw UTC ISO string.
 */

import { describe, expect, test } from "bun:test";
import { formatCommitTime } from "../../../../../src/renderer/components/editor/commit-tab";

const ISO = "2026-10-27T06:13:55.000Z";

describe("formatCommitTime", () => {
  test("formats in the given locale and local time zone", () => {
    const expected = new Intl.DateTimeFormat("ko", {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(ISO));

    expect(formatCommitTime(ISO, "ko")).toBe(expected);
    expect(formatCommitTime(ISO, "en")).not.toBe(ISO);
  });

  test("returns unparseable input unchanged", () => {
    expect(formatCommitTime("not a date", "en")).toBe("not a date");
  });
});
