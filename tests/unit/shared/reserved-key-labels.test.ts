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

test("Windows system keys have Korean action descriptions, and the CLI's refusal names the Settings page", async () => {
  const locale = i18next.createInstance();
  await locale.init(createI18n({ lng: "ko" }).options);
  for (const [primary, expected] of [
    ["Alt+F4", "창 닫기"],
    ["Alt+Escape", "창 순환"],
  ] as const) {
    const conflict = detectConflicts({
      command: "test.action",
      primary,
      bindings: [],
      isMac: false,
      isWindows: true,
    }).find(({ reserved }) => reserved);
    expect(locale.t(`settings:keybindings.reservedNote.${conflict?.reserved?.noteKey}`)).toBe(
      expected,
    );
  }
  expect(locale.t("settings:keybindings.conflict.screenSaves")).toBe(
    "설정 › 단축키 화면에서는 경고와 함께 저장할 수 있습니다",
  );
});
