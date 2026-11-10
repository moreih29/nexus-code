/**
 * A chat tab's text at the size and in the font Settings › Agent set: the
 * reply's size, the app's text sizes scaled as it is, and the font ahead of
 * the app's.
 */

import { describe, expect, it } from "bun:test";
import {
  chatFontVars,
  isChatFontFamily,
} from "../../../../../src/renderer/services/chat/chat-font";
import { fontFamily } from "../../../../../src/shared/design-tokens";

describe("chatFontVars", () => {
  it("puts the font ahead of the app's: a name quoted, a kind of font or a list as it is", () => {
    expect(chatFontVars(undefined, "Noto Sans KR")["--chat-font-family"]).toBe(
      `"Noto Sans KR", ${fontFamily.sans}`,
    );
    expect(chatFontVars(undefined, "ui-rounded")["--chat-font-family"]).toBe(
      `ui-rounded, ${fontFamily.sans}`,
    );
    expect(chatFontVars(undefined, "'Inter', Arial")["--chat-font-family"]).toBe(
      `'Inter', Arial, ${fontFamily.sans}`,
    );
  });

  it("takes the system's font as each platform names it, Windows' Segoe UI ahead of its locale's", () => {
    // Korean Windows gives system-ui as Malgun Gothic, Latin letters too.
    expect(chatFontVars(undefined, "system-ui")["--chat-font-family"]).toBe(
      `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, ${fontFamily.sans}`,
    );
  });
});

describe("what a chat's text can be", () => {
  it("is a font name CSS cannot be slipped into", () => {
    expect(isChatFontFamily("Apple SD Gothic Neo")).toBe(true);
    expect(isChatFontFamily("system-ui")).toBe(true);
    expect(isChatFontFamily("x;}body{color:red")).toBe(false);
    expect(isChatFontFamily("")).toBe(false);
  });
});
