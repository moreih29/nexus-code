import { afterEach, describe, expect, test } from "bun:test";
import i18next from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import type { UpdateProgress, UpdateStatus } from "../../../../../src/shared/updates/status";

// The Vite define the panel prints; Bun test has no bundler pass.
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= "1.2.3";

const { AboutPanel, UpdateSection, VersionRow } = await import(
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
  /**
   * The panel's links to the site: label, address, and that each opens in a
   * new tab, marked as leaving the app.
   */
  function siteLinks(html: string): [string, string][] {
    return Array.from(
      html.matchAll(
        /<a [^>]*data-testid="about-site-[^"]+"[^>]*>(<svg[\s\S]*?<\/svg>)?([^<]+)<\/a>/g,
      ),
      (m) => {
        const tag = m[0];
        expect(tag).toContain('target="_blank"');
        expect(tag).toContain('rel="noopener noreferrer"');
        expect(m[1]).toContain("lucide-external-link");
        return [m[2] ?? "", tag.match(/href="([^"]+)"/)?.[1] ?? ""];
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

describe("AboutPanel's groups", () => {
  /** The groups' titles, top to bottom. */
  function titles(html: string): string[] {
    return Array.from(html.matchAll(/<h3 [^>]*>([^<]+)<\/h3>/g), (m) => m[1] ?? "");
  }

  test("puts the app first, then its updates, the website and the logs, each titled", () => {
    const html = renderWithHost({ platform: "darwin" });
    expect(titles(html)).toEqual(["Updates", "Links", "Logs"]);
    // The app above them all, its release notes beside it.
    expect(html.indexOf("NexusCode")).toBeLessThan(html.indexOf(">Updates<"));
    expect(html.indexOf('data-testid="about-release-notes"')).toBeLessThan(
      html.indexOf(">Updates<"),
    );
    // The version heads the updates, the auto check under it.
    expect(html.indexOf(">Updates<")).toBeLessThan(html.indexOf("Version 1.2.3"));
    expect(html.indexOf("Version 1.2.3")).toBeLessThan(
      html.indexOf("Automatically check for updates"),
    );
    expect(html.indexOf('data-testid="about-site-home"')).toBeLessThan(
      html.indexOf('data-testid="about-open-logs"'),
    );
  });

  test("a Microsoft Store install has the same groups", () => {
    expect(titles(renderWithHost({ platform: "win32", windowsStore: true }))).toEqual([
      "Updates",
      "Links",
      "Logs",
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

    expect(html).toContain("Version 1.2.3");
    expect(html).toContain("Updates come from the Microsoft Store.");
    expect(html).toContain("Open Microsoft Store");
    expect(html).not.toContain("Automatically check for updates");
    expect(html).not.toContain("Check for Updates");
  });

  /** The version row as `status` and `progress` show it, outside the Store. */
  function renderRow(status: UpdateStatus | null, progress: UpdateProgress | null = null): string {
    return renderToStaticMarkup(
      <VersionRow status={status} progress={progress} storeManaged={false} />,
    );
  }

  test("the version row says the app is up to date, and checks again", () => {
    const html = renderRow({ kind: "current", trigger: "manual", current: "1.2.3" });
    expect(html).toContain("Version 1.2.3");
    expect(html).toContain("You&#x27;re on the latest version.");
    expect(html).toContain("Check for Updates");
    // Before any check the version stands alone, with the check beside it.
    const unchecked = renderRow(null);
    expect(unchecked).toContain("Version 1.2.3");
    expect(unchecked).toContain("Check for Updates");
  });

  test("the version row offers a newer version", () => {
    const html = renderRow({
      kind: "newer",
      trigger: "manual",
      current: "1.2.3",
      latest: "1.3.0",
      releaseUrl: "https://example.invalid/r",
      canInstall: true,
    });
    expect(html).toContain("Version 1.3.0 is available.");
    expect(html).toContain(">Update<");
    expect(html).not.toContain("Check for Updates");
    // The release notes are the app's, above.
    expect(html).not.toContain("Release Notes");
  });

  test("the version row shows the download's bar under it", () => {
    const mb = 1024 * 1024;
    const html = renderRow(
      { kind: "downloading", version: "1.3.0" },
      { version: "1.3.0", transferred: 20 * mb, total: 80 * mb, bytesPerSecond: 5 * mb },
    );
    expect(html).toContain("Downloading version 1.3.0");
    expect(html).toContain('aria-valuenow="25"');
    expect(html.indexOf("Downloading version 1.3.0")).toBeLessThan(html.indexOf("progressbar"));
  });

  test("the version row says a failed check in red", () => {
    const html = renderRow({ kind: "error", trigger: "manual", reason: "network" });
    expect(html).toMatch(/<span class="[^"]*text-destructive[^"]*">Couldn&#x27;t check/);
    expect(html).toContain("Check for Updates");
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
