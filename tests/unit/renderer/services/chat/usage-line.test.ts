import { describe, expect, test } from "bun:test";
import {
  resetParts,
  shownReset,
  type UsageLine,
  type UsageView,
  usageViews,
} from "../../../../../src/renderer/services/chat/usage-line";

const AT = Date.parse("2026-11-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

/** A view in a word per part: what shows of each, what is counted, and the profile. */
function said(view: UsageView): string {
  const parts: string[] = [];
  if (view.context) {
    parts.push(
      ["context", view.context.word && "word", view.context.tokens && "tokens"]
        .filter(Boolean)
        .join(" "),
    );
  }
  for (const m of view.meters) {
    parts.push(
      [m.bar && "bar", `${m.meter.kind}:${m.word}`, m.reset && `reset:${m.reset}`]
        .filter(Boolean)
        .join(" "),
    );
  }
  const hidden = (view.hidden.context ? 1 : 0) + view.hidden.meters.length;
  if (hidden > 0) parts.push(`+${hidden}`);
  parts.push(view.profileName ? "name" : "dot");
  return parts.join(" | ");
}

function line(context: number | null, session: number, weekly: number): UsageLine {
  return {
    ...(context !== null ? { context: { percent: context, used: 17_500, max: 400_000 } } : {}),
    meters: [
      { kind: "session", percent: session, resetsAt: AT + 3 * 3_600_000 },
      { kind: "weekly", percent: weekly, resetsAt: AT + 2 * 86_400_000 },
    ],
    more: [],
  };
}

describe("the usage line, as a tab narrows", () => {
  test("it says less, the least wanted first; what is near its limit holds out longest", () => {
    expect(usageViews(line(4, 0, 98)).map(said)).toEqual([
      "context word tokens | bar session:long reset:long | bar weekly:long reset:long | name",
      "context word | bar session:long reset:long | bar weekly:long reset:long | name",
      "context word | bar session:long | bar weekly:long reset:long | name",
      "context | bar session:short | bar weekly:short reset:short | name",
      "context | session:short | weekly:short reset:short | name",
      "context | session:short | weekly:short reset:short | dot",
      "context | weekly:short reset:short | +1 | dot",
      "weekly:short reset:short | +2 | dot",
      "weekly:short | +2 | dot",
    ]);
  });

  test("with nothing near its limit, the context is the last there is to say", () => {
    const views = usageViews(line(50, 10, 30));
    expect(views.every((view) => view.context !== undefined)).toBe(true);
    expect(said(views.at(-1) as UsageView)).toBe("context | +2 | dot");
  });

  test("a context near its limit stays beside the meters near theirs", () => {
    const views = usageViews(line(85, 0, 98));
    expect(views.every((view) => !view.hidden.context)).toBe(true);
    expect(said(views.at(-1) as UsageView)).toBe("context | weekly:short | +1 | dot");
  });

  test("no step says the same as the one before: none for tokens without a context, none for a name without a profile", () => {
    const views = usageViews(line(null, 0, 98), { profile: false }).map(said);
    expect(views).toEqual([
      "bar session:long reset:long | bar weekly:long reset:long | dot",
      "bar session:long | bar weekly:long reset:long | dot",
      "bar session:short | bar weekly:short reset:short | dot",
      "session:short | weekly:short reset:short | dot",
      "weekly:short reset:short | +1 | dot",
      "weekly:short | +1 | dot",
    ]);
  });
});

describe("a reset as it is shown", () => {
  test("is the nearest minute: a hair before the hour or after it is the hour", () => {
    const hour = Date.parse("2026-11-12T01:00:00Z");
    const before = resetParts(Date.parse("2026-11-12T00:59:59.973Z"), hour - DAY, "en");
    const after = resetParts(Date.parse("2026-11-12T01:00:00.031Z"), hour - DAY, "en");
    expect(before.time).toBe(after.time);
    expect(before.time).toBe(resetParts(hour, hour - DAY, "en").time);
    expect(shownReset(Date.parse("2026-11-12T01:00:29Z")).getTime()).toBe(hour);
    expect(shownReset(Date.parse("2026-11-12T01:00:31Z")).getTime()).toBe(hour + 60_000);
  });
});
