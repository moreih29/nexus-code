import { appTypeScale, fontFamily } from "../../../shared/design-tokens";

export const CHAT_FONT_SIZE = 14;
export const CHAT_FONT_SIZE_MIN = 10;
export const CHAT_FONT_SIZE_MAX = 24;

export const CHAT_FONT_FAMILY_RE = /^[A-Za-z0-9\s,'"-]+$/;

export function isChatFontSize(size: unknown): size is number {
  return (
    typeof size === "number" &&
    Number.isInteger(size) &&
    size >= CHAT_FONT_SIZE_MIN &&
    size <= CHAT_FONT_SIZE_MAX
  );
}

export function isChatFontFamily(family: unknown): family is string {
  return typeof family === "string" && family.length <= 120 && CHAT_FONT_FAMILY_RE.test(family);
}

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

const SYSTEM_UI = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui';

function cssFamily(family: string): string {
  const name = family.trim();
  if (name === "system-ui") return SYSTEM_UI;
  return /[,'"]/.test(name) || GENERIC_FAMILIES.has(name) ? name : `"${name}"`;
}

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
