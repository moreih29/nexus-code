import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SummaryBanner } from "../../../../../src/renderer/components/notes/summary-banner";
import type { RecordingSummary } from "../../../../../src/shared/notes/summary";

const run = { agent: "claude", runId: "run", startedAt: 0, seen: false } as const;
const finished = { ...run, endedAt: 1000 };

function render(summary: RecordingSummary, onShow?: () => void): string {
  return renderToStaticMarkup(
    <SummaryBanner
      workspaceId="ws"
      noteId="note"
      recordingId="recording"
      summary={summary}
      flush={async () => true}
      onShow={onShow}
    />,
  );
}

function buttons(html: string): (string | undefined)[] {
  return Array.from(html.matchAll(/<button[^>]*>([^<]+)<\/button>/g), (match) => match[1]);
}

test.each([
  [{ ...run, state: "running" }, "Summarizing recording · Claude", ["Cancel"]],
  [{ ...finished, state: "done", todos: 0 }, "Recording summary ready", ["Undo", "Close"]],
  [
    { ...finished, state: "done", todos: 1 },
    "Recording summary · 1 to-do added",
    ["Undo", "Close"],
  ],
  [
    { ...finished, state: "done", todos: 3 },
    "Recording summary · 3 to-dos added",
    ["Undo", "Close"],
  ],
  [
    { ...finished, state: "failed", error: { kind: "signed-out" } },
    "Summary failed · Claude sign-in needed",
    ["Open settings", "Close"],
  ],
  [
    { ...finished, state: "failed", error: { kind: "missing" } },
    "Summary failed · Claude unavailable",
    ["Open settings", "Close"],
  ],
  [
    { ...finished, state: "failed", error: { kind: "limit" } },
    "Summary failed · Usage limit",
    ["Retry", "Close"],
  ],
  [
    { ...finished, state: "failed", error: { kind: "limit", resetsAt: 1 } },
    "Summary failed · Usage limit · After",
    ["Retry", "Close"],
  ],
  [
    { ...finished, state: "failed", error: { kind: "too-long" } },
    "Summary skipped · Transcript too long",
    ["Close"],
  ],
  [{ ...finished, state: "skipped" }, "Summary skipped · Short recording", ["Close"]],
  [
    { ...finished, state: "failed", error: { kind: "interrupted" } },
    "Summary interrupted",
    ["Retry", "Details", "Close"],
  ],
  [
    { ...finished, state: "failed", error: { kind: "timeout" } },
    "Summary failed · Time limit reached",
    ["Retry", "Details", "Close"],
  ],
  [
    { ...finished, state: "failed", error: { kind: "failed" } },
    "Summary failed",
    ["Retry", "Details", "Close"],
  ],
] satisfies Array<
  [RecordingSummary, string, string[]]
>)("renders %j with the available actions", (summary, label, expected) => {
  const html = render(summary);
  expect(html).toContain(label);
  expect(buttons(html)).toEqual(expected);
});

test("a running summary says where its result goes", () => {
  expect(render({ ...run, state: "running" })).toContain(
    "Summary and to-dos added at the end of the note",
  );
});

test("a finished summary can be shown in the note", () => {
  const html = render({ ...finished, state: "done", todos: 2 }, () => {});
  expect(buttons(html)).toEqual(["Show summary", "Undo", "Close"]);
});

test.each([
  { ...finished, state: "done", todos: 0, seen: true },
  { ...finished, state: "skipped", seen: true },
  { ...finished, state: "undone" },
] satisfies RecordingSummary[])("hides %j", (summary) => {
  expect(render(summary)).toBe("");
});
