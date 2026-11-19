import { expect, test } from "bun:test";
import i18next from "i18next";
import { createI18n } from "../../../src/shared/i18n";
import { detectConflicts } from "../../../src/shared/keybindings/conflicts";

test("system and terminal shortcut conflicts have Korean action descriptions", async () => {
  const locale = i18next.createInstance();
  await locale.init(createI18n({ lng: "ko" }).options);
  for (const [primary, expected] of [
    ["Cmd+Q", "앱 종료"],
    ["Ctrl+R", "명령 기록 역방향 검색"],
  ] as const) {
    const conflict = detectConflicts({
      command: "test.action",
      primary,
      bindings: [],
      isMac: true,
    }).find(({ reserved }) => reserved);
    expect(locale.t(`settings:keybindings.reservedNote.${conflict?.reserved?.noteKey}`)).toBe(
      expected,
    );
  }
});
