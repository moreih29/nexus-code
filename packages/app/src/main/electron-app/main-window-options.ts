import type { BrowserWindowConstructorOptions } from "electron";

import type { NexusPlatform } from "../../common/platform";

export interface MainWindowOptionsInput {
  platform: NexusPlatform;
  preloadPath: string;
}

export function createMainWindowOptions({
  platform,
  preloadPath,
}: MainWindowOptionsInput): BrowserWindowConstructorOptions {
  const baseOptions: BrowserWindowConstructorOptions = {
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      contextIsolation: true,
      preload: preloadPath,
    },
  };

  if (platform !== "darwin") {
    return baseOptions;
  }

  return {
    ...baseOptions,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 10 },
  };
}
