import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TitleBar } from "../../../../../src/renderer/components/workbench/title-bar";

const globals = globalThis as { window?: unknown };
const originalWindow = globals.window;

/**
 * Renders the title bar under the preload's host info.
 */
function renderWithHost(host: { platform: NodeJS.Platform; transparentWindow?: boolean }): string {
  globals.window = { host };
  return renderToStaticMarkup(<TitleBar />);
}

afterEach(() => {
  globals.window = originalWindow;
});

describe("TitleBar window controls", () => {
  test("draws its own controls in a transparent Linux window", () => {
    const html = renderWithHost({ platform: "linux", transparentWindow: true });

    expect(html).toContain('aria-label="Minimize"');
    expect(html).toContain('aria-label="Maximize"');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain("padding-right:4px");
  });

  test("leaves the controls to the window frame otherwise", () => {
    for (const platform of ["linux", "win32"] as const) {
      const html = renderWithHost({ platform });

      expect(html).not.toContain('aria-label="Minimize"');
      expect(html).not.toContain('aria-label="Close"');
      expect(html).toContain("padding-right:140px");
    }
  });
});

describe("TitleBar menu button", () => {
  test("opens the app menu where no menu bar shows", () => {
    for (const platform of ["linux", "win32"] as const) {
      expect(renderWithHost({ platform })).toContain('aria-label="Open menu"');
    }
    expect(renderWithHost({ platform: "linux", transparentWindow: true })).toContain(
      'aria-label="Open menu"',
    );
  });

  test("is left out on macOS, which has its menu bar", () => {
    expect(renderWithHost({ platform: "darwin" })).not.toContain('aria-label="Open menu"');
  });
});
