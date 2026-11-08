/**
 * The line under a chat tab's composer: the context and the plan's usage
 * windows, from what the Claude or Codex program last reported.
 */

import { describe, expect, it } from "bun:test";
import { emptyCodexModel } from "../../../../../src/renderer/services/chat/codex-model";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import {
  claudeUsageLine,
  codexUsageLine,
  formatTokens,
  resetParts,
} from "../../../../../src/renderer/services/chat/usage-line";

describe("formatTokens", () => {
  it("counts in k and M past a thousand, with one decimal kept when it says something", () => {
    expect([942, 1000, 1500, 1049, 24_512, 999_960, 1_200_000].map(formatTokens)).toEqual([
      "942",
      "1k",
      "1.5k",
      "1k",
      "24.5k",
      "1M",
      "1.2M",
    ]);
  });
});

const NOW = Date.parse("2026-11-08T10:00:00Z");
const HOUR = 60 * 60 * 1000;

const contextUsage = {
  categories: [
    { name: "Messages", tokens: 30_000, kind: "used" },
    { name: "Free space", tokens: 900_000, kind: "free" },
  ],
  totalTokens: 40_800,
  maxTokens: 1_000_000,
};

const usage = (limits: unknown[]) => ({ rate_limits: { limits } });

describe("claudeUsageLine", () => {
  it("has nothing to show before the program answers", () => {
    expect(claudeUsageLine(emptyModel(), NOW)).toBeNull();
  });

  it("shows the context, the session and the week; a model's week only on hover", () => {
    const model = {
      ...emptyModel(),
      contextUsage,
      usage: usage([
        { kind: "session", percent: 32, resets_at: new Date(NOW + 3 * HOUR).toISOString() },
        { kind: "weekly_all", percent: 12, resets_at: new Date(NOW + 80 * HOUR).toISOString() },
        {
          kind: "weekly_scoped",
          percent: 40,
          scope: { model: { display_name: "Opus" } },
          resets_at: new Date(NOW + 80 * HOUR).toISOString(),
        },
      ]),
    };
    expect(claudeUsageLine(model, NOW)).toEqual({
      context: { percent: 4, used: 40_800, max: 1_000_000 },
      meters: [
        { kind: "session", percent: 32, resetsAt: NOW + 3 * HOUR },
        { kind: "weekly", percent: 12, resetsAt: NOW + 80 * HOUR },
      ],
      more: [{ kind: "weekly_scoped", scope: "Opus", percent: 40, resetsAt: NOW + 80 * HOUR }],
    });
  });

  it("leaves out a window that has started over since it was read", () => {
    const model = {
      ...emptyModel(),
      usage: usage([
        { kind: "session", percent: 95, resets_at: new Date(NOW - HOUR).toISOString() },
        { kind: "weekly_all", percent: 12 },
      ]),
    };
    expect(claudeUsageLine(model, NOW)?.meters).toEqual([{ kind: "weekly", percent: 12 }]);
  });
});

describe("codexUsageLine", () => {
  it("shows the thread's context and the plan's windows", () => {
    const model = {
      ...emptyCodexModel(),
      tokens: { used: 31_000, window: 258_000 },
      rateLimits: {
        primary: { usedPercent: 20, windowMins: 300, resetsAt: NOW / 1000 + 3600 },
        secondary: { usedPercent: 8, windowMins: 10080, resetsAt: NOW / 1000 + 86_400 * 4 },
      },
    };
    expect(codexUsageLine(model, NOW)).toEqual({
      context: { percent: 12, used: 31_000, max: 258_000 },
      meters: [
        { kind: "window", windowMins: 300, percent: 20, resetsAt: NOW + HOUR },
        { kind: "weekly", percent: 8, resetsAt: NOW + 96 * HOUR },
      ],
      more: [],
    });
  });

  it("has nothing to show without a window size or limits", () => {
    expect(codexUsageLine({ ...emptyCodexModel(), tokens: { used: 10 } }, NOW)).toBeNull();
  });
});

describe("resetParts", () => {
  it("tells the time alone within a day, and the date beyond", () => {
    const at = new Date(2026, 10, 12, 9, 5).getTime();
    expect(resetParts(at, at - 3 * HOUR, "ko")).toEqual({
      soon: true,
      time: "09:05",
      month: 11,
      day: 12,
      weekday: "목",
    });
    expect(resetParts(at, at - 30 * HOUR, "en")).toMatchObject({ soon: false, weekday: "Thu" });
    expect(resetParts(new Date(2026, 10, 12, 15, 0).getTime(), at, "en").time).toBe("15:00");
  });
});
