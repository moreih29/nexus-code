import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UpdateProgress, UpdateStatus } from "../../../../../src/shared/updates/status";

// The Vite define the panel prints; Bun test has no bundler pass.
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= "1.2.3";

const { AboutPanel, UpdateSection } = await import(
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

// The panel reads the updates store, which a server render sees only in its
// initial state; the section showing a status is rendered on its own.
function renderStatus(status: UpdateStatus, progress: UpdateProgress | null = null): string {
  return renderToStaticMarkup(<UpdateSection status={status} progress={progress} />);
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

  test("shows how far a download has got", () => {
    const mb = 1024 * 1024;
    const html = renderStatus(
      { kind: "downloading", version: "1.3.0" },
      { version: "1.3.0", transferred: 40 * mb, total: 80 * mb, bytesPerSecond: 5 * mb },
    );

    expect(html).toContain("Downloading version 1.3.0");
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain("50% · 40 MB / 80 MB · 5.0 MB/s");
    expect(html).not.toContain("Check for Updates");
  });

  test("offers the restart once the update is staged", () => {
    const html = renderStatus({ kind: "ready", version: "1.3.0" });

    expect(html).toContain("Version 1.3.0 is ready.");
    expect(html).toContain("Restart Now");
  });
});
