import { afterEach, describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import {
  idlePlaceholder,
  runningPlaceholder,
} from "../../../../../src/renderer/components/chat/composer";
import { setPlatformForTests } from "../../../../../src/renderer/utils/platform";

const t = ((key: string, options: Record<string, string>) =>
  `${key} ${JSON.stringify(options)}`) as unknown as TFunction;

afterEach(() => setPlatformForTests(null));

describe("composer hints", () => {
  test("name the Mac's keys with its symbols on macOS", () => {
    setPlatformForTests("darwin");
    const keys = JSON.stringify({ send: "↩", newLine: "⇧↩", queueKey: "⌘↩", nowKey: "⌘⇧↩" });
    expect(runningPlaceholder(t, "chat.composer.placeholder_running")).toBe(
      `chat.composer.placeholder_running ${keys}`,
    );
    expect(runningPlaceholder(t, "chat.codex.placeholder_running")).toBe(
      `chat.codex.placeholder_running ${keys}`,
    );
    expect(idlePlaceholder(t, "chat.composer.placeholder")).toBe(
      `chat.composer.placeholder ${keys}`,
    );
    expect(idlePlaceholder(t, "chat.codex.placeholder")).toBe(`chat.codex.placeholder ${keys}`);
  });

  test("spell the keys out on Linux and Windows", () => {
    const keys = JSON.stringify({
      send: "Enter",
      newLine: "Shift+Enter",
      queueKey: "Ctrl+Enter",
      nowKey: "Ctrl+Shift+Enter",
    });
    for (const platform of ["linux", "win32"] as const) {
      setPlatformForTests(platform);
      expect(runningPlaceholder(t, "chat.composer.placeholder_running")).toBe(
        `chat.composer.placeholder_running ${keys}`,
      );
      expect(idlePlaceholder(t, "chat.composer.placeholder")).toBe(
        `chat.composer.placeholder ${keys}`,
      );
      expect(idlePlaceholder(t, "chat.codex.placeholder")).toBe(`chat.codex.placeholder ${keys}`);
    }
  });
});
