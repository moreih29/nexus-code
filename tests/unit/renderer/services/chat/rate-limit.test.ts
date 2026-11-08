/**
 * The usage-limit notice above a Claude tab's composer: a limit reached
 * always shows; a limit near shows unless warnings are off or the user
 * closed that window's warning.
 */

import { describe, expect, it } from "bun:test";
import type { RateLimitInfo } from "../../../../../src/renderer/services/chat/model";
import {
  rateLimitKey,
  rateLimitNotice,
} from "../../../../../src/renderer/services/chat/rate-limit";

const on = { warnings: true, dismissed: new Set<string>() };
const near: RateLimitInfo = {
  status: "allowed_warning",
  resetsAt: 1_700_000_000,
  rateLimitType: "five_hour",
};

describe("rateLimitNotice", () => {
  it("shows nothing under the limit or without one", () => {
    expect(rateLimitNotice(undefined, on)).toBeNull();
    expect(rateLimitNotice({ status: "allowed" }, on)).toBeNull();
  });

  it("warns near the limit", () => {
    expect(rateLimitNotice(near, on)).toBe("warning");
  });

  it("keeps the warning down when warnings are off or this one was closed", () => {
    expect(rateLimitNotice(near, { ...on, warnings: false })).toBeNull();
    expect(rateLimitNotice(near, { ...on, dismissed: new Set([rateLimitKey(near)]) })).toBeNull();
  });

  it("warns again for the next window once the limit resets", () => {
    const closed = { ...on, dismissed: new Set([rateLimitKey(near)]) };
    expect(rateLimitNotice({ ...near, resetsAt: 1_700_018_000 }, closed)).toBe("warning");
    expect(rateLimitNotice({ ...near, rateLimitType: "seven_day" }, closed)).toBe("warning");
  });

  it("always shows a limit reached", () => {
    const reached = { ...near, status: "rejected" };
    expect(
      rateLimitNotice(reached, { warnings: false, dismissed: new Set([rateLimitKey(reached)]) }),
    ).toBe("rejected");
  });
});
