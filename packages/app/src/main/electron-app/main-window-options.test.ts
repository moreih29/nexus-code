import { describe, expect, test } from "bun:test";

import { createMainWindowOptions } from "./main-window-options";

describe("createMainWindowOptions", () => {
  test("keeps default chrome options unchanged off macOS", () => {
    const options = createMainWindowOptions({
      platform: "linux",
      preloadPath: "/tmp/preload/index.cjs",
    });

    expect(options).toEqual({
      width: 1280,
      height: 800,
      minWidth: 960,
      minHeight: 640,
      webPreferences: {
        contextIsolation: true,
        preload: "/tmp/preload/index.cjs",
      },
    });
    expect("titleBarStyle" in options).toBe(false);
    expect("trafficLightPosition" in options).toBe(false);
  });

  test("keeps default BrowserWindow chrome options on Windows", () => {
    const options = createMainWindowOptions({
      platform: "win32",
      preloadPath: "C:\\nexus\\preload\\index.cjs",
    });

    expect(options).toEqual({
      width: 1280,
      height: 800,
      minWidth: 960,
      minHeight: 640,
      webPreferences: {
        contextIsolation: true,
        preload: "C:\\nexus\\preload\\index.cjs",
      },
    });
    expect("titleBarStyle" in options).toBe(false);
    expect("trafficLightPosition" in options).toBe(false);
  });

  test("uses hiddenInset titlebar and inset traffic lights on macOS", () => {
    const options = createMainWindowOptions({
      platform: "darwin",
      preloadPath: "/tmp/preload/index.cjs",
    });

    expect(options).toEqual({
      width: 1280,
      height: 800,
      minWidth: 960,
      minHeight: 640,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 10 },
      webPreferences: {
        contextIsolation: true,
        preload: "/tmp/preload/index.cjs",
      },
    });
  });
});
