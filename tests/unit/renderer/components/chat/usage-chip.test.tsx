/**
 * The plan's usage as a chip, in the agents tab's detail: each meter's bar,
 * short name and percent; hovering tells the account and each meter whole.
 * Nothing when the plan reports no limits, as with an API key.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageChip } from "../../../../../src/renderer/components/chat/usage-line";
import type { UsageLine } from "../../../../../src/renderer/services/chat/usage-line";

const line: UsageLine = {
  meters: [
    { kind: "session", percent: 12 },
    { kind: "weekly", percent: 91 },
  ],
  more: [{ kind: "weekly_scoped", scope: "Fable", percent: 4 }],
};

/** The chip's tooltip, its entities undone. */
function tipOf(html: string): string {
  const raw = html.match(/data-tooltip="([^"]*)"/)?.[1] ?? "";
  return raw.replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"');
}

describe("UsageChip", () => {
  it("shows each meter by its short name and percent", () => {
    const html = renderToStaticMarkup(<UsageChip line={line} />);
    expect(html).toContain('data-usage="session"');
    expect(html).toContain('data-usage="weekly"');
    expect(html).toContain(">Session<");
    expect(html).toContain(">Week<");
    expect(html).toContain("12%");
    expect(html).toContain("91%");
  });

  it("warns from 80%", () => {
    const html = renderToStaticMarkup(<UsageChip line={line} />);
    const weekly = html.slice(html.indexOf('data-usage="weekly"'));
    expect(weekly).toContain("state-warning-fg");
    const session = html.slice(
      html.indexOf('data-usage="session"'),
      html.indexOf('data-usage="weekly"'),
    );
    expect(session).not.toContain("state-warning-fg");
  });

  it("tells the account first on hover, then each meter whole with every model's week", () => {
    const tip = tipOf(renderToStaticMarkup(<UsageChip line={line} head="Work" />));
    expect(tip.split("\n")).toEqual([
      "Work",
      "Session: 12% used",
      "This week, all models: 91% used",
      "This week, Fable: 4% used",
    ]);
  });

  it("is nothing without limits to tell", () => {
    expect(renderToStaticMarkup(<UsageChip line={{ meters: [], more: [] }} head="Work" />)).toBe(
      "",
    );
  });
});
