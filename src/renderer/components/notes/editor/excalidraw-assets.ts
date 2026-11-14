/**
 * Where Excalidraw loads its fonts from: the copy the app ships
 * (electron.vite.config.ts, excalidrawAssetsPlugin), not its CDN. Imported
 * before Excalidraw so it is set when Excalidraw first reads it.
 */
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

window.EXCALIDRAW_ASSET_PATH = new URL("excalidraw/", window.location.href).href;

export {};
