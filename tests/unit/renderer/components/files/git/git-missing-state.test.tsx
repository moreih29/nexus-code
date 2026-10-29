import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GitMissingState } from "../../../../../../src/renderer/components/files/git/panel/git-missing-state";

const globals = globalThis as { window?: unknown };
const originalWindow = globals.window;

/**
 * Renders the state under the preload's platform.
 */
function render(platform: NodeJS.Platform, remote = false): string {
  globals.window = { host: { platform } };
  return renderToStaticMarkup(<GitMissingState remote={remote} />);
}

afterEach(() => {
  globals.window = originalWindow;
});

describe("GitMissingState", () => {
  test("asks Windows users for Git for Windows and a reopen", () => {
    const html = render("win32");

    expect(html).toContain("Git Is Not Installed");
    expect(html).toContain("Install Git for Windows, then quit and reopen the app.");
    expect(html).toContain("Download Git");
    expect(html).not.toContain("Initialize");
  });

  test("names the install on macOS and Linux", () => {
    expect(render("darwin")).toContain("xcode-select --install");
    expect(render("linux")).toContain("package manager");
  });

  test("asks for Git on the SSH host and a refresh, with no local download", () => {
    const html = render("win32", true);

    expect(html).toContain(
      "Source control needs Git on the remote host. Install git there, then refresh.",
    );
    expect(html).not.toContain("Download Git");
  });
});
