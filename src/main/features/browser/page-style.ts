/**
 * Per-page style injection for embedded browser tabs.
 *
 * Browser tabs render arbitrary third-party content with their own document,
 * disconnected from our renderer's CSS tree.  The native Chromium scrollbar
 * looks out of place next to our VSCode-style thin scrollbar everywhere
 * else in the app, so we use `webContents.insertCSS()` to overwrite the
 * scrollbar styling on every page load.
 *
 * INJECTION LIFECYCLE
 * -------------------
 * `insertCSS()` returns a key that can be used to remove the style later,
 * but the style only survives for the lifetime of the document.  A
 * cross-document navigation (`did-finish-load` on a new URL) discards it,
 * so we re-inject on every `did-finish-load`.  In-page navigations (`#hash`
 * or pushState) keep the same document and retain the style.
 *
 * STYLE CHOICE
 * ------------
 * Browser content can be light or dark — we pick a semi-transparent grey
 * thumb that has enough contrast over both.  Width matches the app's
 * `@utility app-scrollbar`: 10px vertical, 8px horizontal.  Hardcoding the
 * values (rather than mirroring the renderer's theme tokens) keeps the
 * injection independent of theme switches, at the cost of not matching the
 * exact dark/light shades per theme.  If we ever want theme-precise
 * scrollbars inside browser tabs, the renderer can push the resolved token
 * triple via IPC and we'll re-inject on theme change.
 */

import type { WebContents } from "electron";
import { createLogger } from "../../../shared/log/main";

const logger = createLogger("browser-page-style");

/**
 * Single source of truth for the scrollbar CSS injected into every browser
 * tab's main frame.  Matches the dimensions of `@utility app-scrollbar` in
 * `src/renderer/styles/globals.css`; the colour palette is mid-grey
 * semi-transparent so it reads on both light and dark pages.
 *
 * `!important` is necessary because many pages ship their own scrollbar
 * styling — we want ours to win at the cascade level without having to
 * out-specify every selector the page might use.
 */
const APP_SCROLLBAR_CSS = `
  ::-webkit-scrollbar {
    width: 10px !important;
    height: 8px !important;
  }
  ::-webkit-scrollbar-track {
    background: transparent !important;
  }
  ::-webkit-scrollbar-thumb {
    background: rgba(127, 127, 127, 0.35) !important;
    border-radius: 4px !important;
    border: 2px solid transparent !important;
    background-clip: padding-box !important;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: rgba(127, 127, 127, 0.55) !important;
    background-clip: padding-box !important;
  }
  ::-webkit-scrollbar-corner {
    background: transparent !important;
  }
`.trim();

/**
 * Wire `did-finish-load` so the app scrollbar CSS is re-injected on every
 * top-level navigation.  `insertCSS` errors are swallowed with a warning —
 * a failed injection should not blow up navigation.
 */
export function installAppScrollbarStyle(webContents: WebContents): void {
  const inject = (): void => {
    if (webContents.isDestroyed()) return;
    webContents.insertCSS(APP_SCROLLBAR_CSS).catch((err: Error) => {
      logger.warn(`[insertCSS] failed: ${err.message}`);
    });
  };

  webContents.on("did-finish-load", inject);
  // Cover the case where the WebContents has already finished loading
  // before this hook runs (race against the initial `loadURL` in
  // registry.create).  `isLoading()` is false once the main frame has
  // committed and finished its initial paint.
  if (!webContents.isLoading()) {
    inject();
  }
}
