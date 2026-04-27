import { XTERM_IME_OVERLAY_CLASS, type StyleDocumentLike } from "./xterm-ime-overlay";

export const XTERM_DEFAULT_FONT_FAMILY =
  '"D2Coding", "Noto Sans KR", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

export const XTERM_FONT_STYLE_ELEMENT_ID = "nx-xterm-font-style";
export const XTERM_FONT_RESOURCE_ROOT = "../../fonts";

export const XTERM_FONT_CSS = `
@font-face {
  font-family: "D2Coding";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: local("D2Coding"), url("${XTERM_FONT_RESOURCE_ROOT}/d2coding/D2Coding-Ver1.3.2-20180524.ttf") format("truetype");
}

@font-face {
  font-family: "D2Coding";
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: local("D2Coding Bold"), url("${XTERM_FONT_RESOURCE_ROOT}/d2coding/D2CodingBold-Ver1.3.2-20180524.ttf") format("truetype");
}

@font-face {
  font-family: "Noto Sans KR";
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: local("Noto Sans KR"), url("${XTERM_FONT_RESOURCE_ROOT}/noto-sans-kr/NotoSansKR[wght].ttf") format("truetype");
}

:root {
  --nx-terminal-font-family: ${XTERM_DEFAULT_FONT_FAMILY};
}

.xterm,
.xterm .xterm-helper-textarea,
.xterm .xterm-rows,
.${XTERM_IME_OVERLAY_CLASS} {
  font-family: var(--nx-terminal-font-family);
}
`;

export function ensureXtermFontStyle(documentLike: StyleDocumentLike | null | undefined): void {
  if (!documentLike) {
    return;
  }

  if (documentLike.getElementById?.(XTERM_FONT_STYLE_ELEMENT_ID)) {
    return;
  }

  const styleElement = documentLike.createElement?.("style");
  if (!styleElement) {
    return;
  }

  styleElement.id = XTERM_FONT_STYLE_ELEMENT_ID;
  styleElement.textContent = XTERM_FONT_CSS;
  documentLike.head?.appendChild?.(styleElement);
}
