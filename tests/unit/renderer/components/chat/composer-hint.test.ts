import { afterEach, describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { composerHint } from "../../../../../src/renderer/components/chat/composer";
import { setPlatformForTests } from "../../../../../src/renderer/utils/platform";

const t = ((key: string, options: Record<string, string>) =>
  `${key} ${JSON.stringify(options)}`) as unknown as TFunction;

afterEach(() => setPlatformForTests(null));

describe("composer hints", () => {
  test("name the Mac's keys with its symbols on macOS", () => {
    setPlatformForTests("darwin");
    const keys = { send: "↩", newLine: "⇧↩", queueKey: "⌘↩", nowKey: "⌘⇧↩" };
    expect(composerHint(t, true, "claude")).toBe(
      `chat.composer.hint_running ${JSON.stringify(keys)}`,
    );
    expect(composerHint(t, false, "claude")).toBe(`chat.composer.hint ${JSON.stringify(keys)}`);
  });

  test("spell the keys out on Linux and Windows", () => {
    const keys = {
      send: "Enter",
      newLine: "Shift+Enter",
      queueKey: "Ctrl+Enter",
      nowKey: "Ctrl+Shift+Enter",
    };
    for (const platform of ["linux", "win32"] as const) {
      setPlatformForTests(platform);
      expect(composerHint(t, true, "claude")).toBe(
        `chat.composer.hint_running ${JSON.stringify(keys)}`,
      );
      expect(composerHint(t, false, "claude")).toBe(`chat.composer.hint ${JSON.stringify(keys)}`);
    }
  });

  test("a Codex tab's are its own: no commands, and ↩ goes in at once", () => {
    setPlatformForTests("darwin");
    const keys = { send: "↩", newLine: "⇧↩", queueKey: "⌘↩", nowKey: "⌘⇧↩" };
    expect(composerHint(t, true, "codex")).toBe(
      `chat.composer.hint_running ${JSON.stringify({ ...keys, context: "codex" })}`,
    );
    expect(composerHint(t, false, "codex")).toBe(
      `chat.composer.hint ${JSON.stringify({ ...keys, context: "codex" })}`,
    );
  });
});
