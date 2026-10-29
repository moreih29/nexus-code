import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// The Vite define the panel prints; Bun test has no bundler pass.
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= "1.2.3";

const { AboutPanel } = await import(
  "../../../../../src/renderer/components/settings/panels/about-panel"
);

const globals = globalThis as { window?: unknown };
const originalWindow = globals.window;

/**
 * Renders the panel under the preload's host info.
 */
function renderWithHost(host: { platform: NodeJS.Platform; windowsStore?: boolean }): string {
  globals.window = { host };
  return renderToStaticMarkup(<AboutPanel />);
}

afterEach(() => {
  globals.window = originalWindow;
});

describe("AboutPanel updates", () => {
  test("offers the update checks outside the Microsoft Store", () => {
    const html = renderWithHost({ platform: "win32" });

    expect(html).toContain("Automatically check for updates");
    expect(html).toContain("Check for Updates");
    expect(html).not.toContain("Microsoft Store");
  });

  test("leaves updates to the Microsoft Store in its build", () => {
    const html = renderWithHost({ platform: "win32", windowsStore: true });

    expect(html).toContain("Updates come from the Microsoft Store.");
    expect(html).not.toContain("Automatically check for updates");
    expect(html).not.toContain("Check for Updates");
  });
});
