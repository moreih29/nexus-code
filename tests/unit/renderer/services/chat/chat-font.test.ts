/**
 * A chat tab's text at the size and in the font Settings › Agent set: the
 * reply's size, the app's text sizes scaled as it is, and the font ahead of
 * the app's.
 */

import { describe, expect, it } from "bun:test";
import {
  chatFontVars,
  isChatFontFamily,
  isChatFontSize,
} from "../../../../../src/renderer/services/chat/chat-font";
import { appTypeScale, fontFamily } from "../../../../../src/shared/design-tokens";

describe("chatFontVars", () => {
  it("is the app's own text when nothing is set", () => {
    const vars = chatFontVars(undefined, undefined);
    expect(vars["--chat-font-family"]).toBe(fontFamily.sans);
    expect(vars["--chat-text-reply"]).toBe("14px");
    expect(vars["--chat-text-app-body"]).toBe(`${appTypeScale.appBody.fontSize}px`);
    expect(vars["--chat-text-app-micro"]).toBe(`${appTypeScale.appMicro.fontSize}px`);
  });

  it("scales every size as the reply's", () => {
    const vars = chatFontVars(21, undefined);
    expect(vars["--chat-text-reply"]).toBe("21px");
    expect(vars["--chat-text-app-ui-sm"]).toBe(`${appTypeScale.appUiSm.fontSize * 1.5}px`);
    expect(chatFontVars(16, undefined)["--chat-text-app-body"]).toBe("14.86px");
  });

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
  it("is a whole size from 10 to 24 px", () => {
    expect([10, 14, 24].every(isChatFontSize)).toBe(true);
    expect([9, 25, 14.5, "14", undefined].some(isChatFontSize)).toBe(false);
  });

  it("is a font name CSS cannot be slipped into", () => {
    expect(isChatFontFamily("Apple SD Gothic Neo")).toBe(true);
    expect(isChatFontFamily("system-ui")).toBe(true);
    expect(isChatFontFamily("x;}body{color:red")).toBe(false);
    expect(isChatFontFamily("")).toBe(false);
  });
});
