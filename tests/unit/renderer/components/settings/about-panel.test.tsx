import { afterEach, describe, expect, test } from "bun:test";
import i18next from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
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

describe("AboutPanel's website links", () => {
  /** The panel's links to the site: label, address, and that each opens in a new tab. */
  function siteLinks(html: string): [string, string][] {
    return Array.from(
      html.matchAll(/<a [^>]*data-testid="about-site-[^"]+"[^>]*>([^<]+)<\/a>/g),
      (m) => {
        const tag = m[0];
        expect(tag).toContain('target="_blank"');
        expect(tag).toContain('rel="noopener noreferrer"');
        return [m[1] ?? "", tag.match(/href="([^"]+)"/)?.[1] ?? ""];
      },
    );
  }

  test("links the website, support and the privacy policy in English", () => {
    expect(siteLinks(renderWithHost({ platform: "darwin" }))).toEqual([
      ["Website", "https://nexuscode.gradiendo.com/en/"],
      ["Support", "https://nexuscode.gradiendo.com/en/support/"],
      ["Privacy Policy", "https://nexuscode.gradiendo.com/en/privacy/"],
    ]);
    // A Microsoft Store install has them too.
    expect(siteLinks(renderWithHost({ platform: "win32", windowsStore: true }))).toHaveLength(3);
  });

  test("links the Korean pages when the app is in Korean", async () => {
    const i18n = i18next.cloneInstance({ lng: "ko" });
    await i18n.changeLanguage("ko");
    globals.window = { host: { platform: "darwin" } };
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <AboutPanel />
      </I18nextProvider>,
    );
    expect(siteLinks(html)).toEqual([
      ["웹사이트", "https://nexuscode.gradiendo.com/"],
      ["지원", "https://nexuscode.gradiendo.com/support/"],
      ["개인정보처리방침", "https://nexuscode.gradiendo.com/privacy/"],
    ]);
  });
});

describe("AboutPanel updates", () => {
  test("offers the update checks outside the Microsoft Store", () => {
    const html = renderWithHost({ platform: "win32" });

    expect(html).toContain("Automatically check for updates");
    expect(html).toContain("Check for Updates");
    expect(html).not.toContain("Microsoft Store");
  });

  test("sends a Microsoft Store install to its Store page", () => {
    const html = renderWithHost({ platform: "win32", windowsStore: true });

    expect(html).toContain("Updates come from the Microsoft Store.");
    expect(html).toContain("Open Microsoft Store");
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
