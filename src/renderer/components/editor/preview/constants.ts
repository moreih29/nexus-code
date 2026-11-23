export const MAX_PREVIEW_BYTES = 1024 * 1024;

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
export const PREVIEW_TRUNCATED_MESSAGE = `Preview truncated at ${MAX_PREVIEW_BYTES / 1024} KB. Switch to Raw to see the full file.`;
