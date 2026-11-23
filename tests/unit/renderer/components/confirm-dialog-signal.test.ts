/** A confirmation whose question was settled elsewhere closes unanswered. */
import { expect, test } from "bun:test";
import { showConfirmDialog } from "../../../../src/renderer/components/ui/confirm-dialog";

test("aborted while shown or waiting: resolves false, the rest of the queue untouched", async () => {
  const first = new AbortController();
  const second = new AbortController();
  const shown = showConfirmDialog({ title: "First", signal: first.signal });
  const queued = showConfirmDialog({ title: "Second", signal: second.signal });
  let queuedAnswer: boolean | undefined;
  void queued.then((answer) => {
    queuedAnswer = answer;
  });
  first.abort();
  expect(await shown).toBe(false);
  await Promise.resolve();
  expect(queuedAnswer).toBeUndefined();
  second.abort();
  expect(await queued).toBe(false);
});

test("already aborted: never shown", async () => {
  const settled = new AbortController();
  settled.abort();
  expect(await showConfirmDialog({ title: "Late", signal: settled.signal })).toBe(false);
});
