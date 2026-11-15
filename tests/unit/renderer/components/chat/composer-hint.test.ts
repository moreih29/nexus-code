/** What an empty composer tells of its keys, and what each does with a message during a turn. */
import { describe, expect, test } from "bun:test";
import i18next from "i18next";

const { composerHint, composerKeys } = await import(
  "../../../../../src/renderer/components/chat/composer"
);

const t = i18next.t.bind(i18next);

describe("the composer's hint", () => {
  test("between turns: send, new line, commands and files; a Codex tab has no commands", () => {
    const { send, newLine } = composerKeys();
    expect(composerHint(t, false, "claude")).toBe(
      `${send} send · ${newLine} new line · / commands · @ files`,
    );
    expect(composerHint(t, false, "codex")).toBe(`${send} send · ${newLine} new line · @ files`);
  });

  test("a Claude tab's turn: Enter waits for the current tool, the now key goes at once, the queue key waits for the turn", () => {
    const { send, nowKey, queueKey } = composerKeys();
    expect(composerHint(t, true, "claude")).toBe(
      `${send} deliver after the current tool · ${nowKey} deliver now · ${queueKey} deliver after the turn`,
    );
  });

  test("a Codex tab's turn: Enter goes in at once, so no now key", () => {
    const { send, nowKey, queueKey } = composerKeys();
    const hint = composerHint(t, true, "codex");
    expect(hint).toBe(`${send} deliver now · ${queueKey} deliver after the turn`);
    expect(hint).not.toContain(`${nowKey} `);
  });
});
