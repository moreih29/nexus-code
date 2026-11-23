import type { WebContents } from "electron";
import { createLogger } from "../../../shared/log/main";

const logger = createLogger("browser-page-style");

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

export function installAppScrollbarStyle(webContents: WebContents): void {
  const inject = (): void => {
    if (webContents.isDestroyed()) return;
    webContents.insertCSS(APP_SCROLLBAR_CSS).catch((err: Error) => {
      logger.warn(`[insertCSS] failed: ${err.message}`);
    });
  };

  webContents.on("did-finish-load", inject);
  if (!webContents.isLoading()) {
    inject();
  }
}
