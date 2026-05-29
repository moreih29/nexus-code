// Shared cap for the live-preview pipelines.
//
// All preview panes (markdown / html / svg) truncate input beyond this
// threshold and surface a banner explaining the cap. The number is a
// tunable heuristic, not a research-backed limit:
//
//   - 50 KB md  ≈ 30 ms parse  → invisible
//   - 200 KB md ≈ 120 ms parse → slight stutter on keystrokes
//   - 512 KB md ≈ 300 ms parse → noticeable but still "live"
//   - 1 MB md   ≈ 600–1000 ms  → broken-feeling
//
// 512 KB sits at the "noticeable but tolerable" knee for react-markdown on
// modern hardware, with the safety margin of a power-of-two round number
// that's an order of magnitude above typical README sizes (1–20 KB).
// Raise or lower in one place if user feedback indicates the wrong knee.

export const MAX_PREVIEW_BYTES = 512 * 1024;

/**
 * Truncate `source` to `MAX_PREVIEW_BYTES` and report whether truncation
 * occurred. UTF-8 friendliness is left to the renderer — `<iframe srcDoc>`
 * and `Blob([str])` both tolerate mid-codepoint cuts (replacement char or
 * dropped glyph at the tail), which is fine because the user can always
 * switch to raw mode to see the full file.
 */
export function capPreviewSource(source: string): {
  text: string;
  truncated: boolean;
} {
  if (source.length <= MAX_PREVIEW_BYTES) {
    return { text: source, truncated: false };
  }
  return { text: source.slice(0, MAX_PREVIEW_BYTES), truncated: true };
}

import i18next from "i18next";
export function getPreviewTruncatedMessage(): string {
  return i18next.t("preview.truncated", { kb: MAX_PREVIEW_BYTES / 1024 });
}
/** @deprecated Use getPreviewTruncatedMessage() for i18n-aware string */
export const PREVIEW_TRUNCATED_MESSAGE = `Preview truncated at ${MAX_PREVIEW_BYTES / 1024} KB. Switch to Raw to see the full file.`;
