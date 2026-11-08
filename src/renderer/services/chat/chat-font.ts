/**
 * The text of a chat tab (Claude or Codex) as Settings › Agent sets it: a
 * size, which its replies have and the rest of its text scales with, and a
 * font, which its code keeps out of. Pure.
 */

import { appTypeScale, fontFamily } from "../../../shared/design-tokens";

/** The size a reply's text has unless one is set. */
export const CHAT_FONT_SIZE = 14;
export const CHAT_FONT_SIZE_MIN = 10;
export const CHAT_FONT_SIZE_MAX = 24;

/**
 * A font family the app keeps for its chats: CSS cannot be slipped into it.
 * A hyphen is allowed, for names such as system-ui.
 */
export const CHAT_FONT_FAMILY_RE = /^[A-Za-z0-9\s,'"-]+$/;

/** Whether `size` is one a chat's text can have. */
export function isChatFontSize(size: unknown): size is number {
  return (
    typeof size === "number" &&
    Number.isInteger(size) &&
    size >= CHAT_FONT_SIZE_MIN &&
    size <= CHAT_FONT_SIZE_MAX
  );
}

/** Whether `family` is one a chat's text can have. */
export function isChatFontFamily(family: unknown): family is string {
  return typeof family === "string" && family.length <= 120 && CHAT_FONT_FAMILY_RE.test(family);
}

/** CSS's own names for kinds of font, which a quote would make a font's name. */
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
]);

/**
 * The system's font, as each platform names its own: macOS's, then
 * Windows', then the generic one. On Windows system-ui alone is the
 * locale's message font, Malgun Gothic on a Korean one even for Latin
 * letters; after Segoe UI it only draws what Segoe UI has not, as Hangul.
 */
const SYSTEM_UI = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui';

/**
 * `family` as CSS takes it: one name quoted, a list or a kind of font as
 * it is, and the system's as SYSTEM_UI.
 */
function cssFamily(family: string): string {
  const name = family.trim();
  if (name === "system-ui") return SYSTEM_UI;
  return /[,'"]/.test(name) || GENERIC_FAMILIES.has(name) ? name : `"${name}"`;
}

/**
 * The CSS custom properties a chat tab's root carries for its text (the
 * `.chat-font` rules in globals.css use them): the font, then the size of
 * a reply and of each of the app's text sizes, scaled as the reply's is.
 */
export function chatFontVars(
  size: number | undefined,
  family: string | undefined,
): Record<string, string> {
  const scale = (size ?? CHAT_FONT_SIZE) / CHAT_FONT_SIZE;
  const px = (base: number) => `${Math.round(base * scale * 100) / 100}px`;
  return {
    "--chat-font-family": family ? `${cssFamily(family)}, ${fontFamily.sans}` : fontFamily.sans,
    "--chat-text-reply": px(CHAT_FONT_SIZE),
    "--chat-text-app-body": px(appTypeScale.appBody.fontSize),
    "--chat-text-app-body-emphasis": px(appTypeScale.appBodyEmphasis.fontSize),
    "--chat-text-app-ui-sm": px(appTypeScale.appUiSm.fontSize),
    "--chat-text-app-micro": px(appTypeScale.appMicro.fontSize),
    "--chat-text-app-label": px(appTypeScale.appLabel.fontSize),
  };
}
