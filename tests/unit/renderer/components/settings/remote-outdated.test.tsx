/** Out of the room while the server no longer takes this version: the update, and the way to it. */
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const { OutdatedGroup, OutdatedLine } = await import(
  "../../../../../src/renderer/components/settings/panels/remote-outdated"
);

const globals = globalThis as { window?: unknown };
const originalWindow = globals.window;

function render(windowsStore = false): string {
  globals.window = { host: { platform: windowsStore ? "win32" : "darwin", windowsStore } };
  return renderToStaticMarkup(<OutdatedGroup />);
}

afterEach(() => {
  globals.window = originalWindow;
});

describe("the update a server that no longer takes this version asks for", () => {
  // The updates store, as a server render sees it, has checked nothing yet;
  // the section's other states are Settings › About's (about-panel.test).
  test("the Remote page says why, with the update's state and buttons", () => {
    const html = render();
    expect(html).toContain("Update needed");
    expect(html).toContain("This version can no longer connect to your other devices.");
    expect(html).toContain('data-testid="remote-outdated-group"');
    expect(html).toContain("Check for Updates");
  });

  test("from the Microsoft Store: the store updates it, and opens from here", () => {
    const html = render(true);
    expect(html).toContain("Updates from the Microsoft Store");
    expect(html).toContain("Open Microsoft Store");
    expect(html).not.toContain("Check for Updates");
  });

  test("the Other computers list: one line, and a button to the update", () => {
    const html = renderToStaticMarkup(
      <OutdatedLine dismiss={{ label: "Dismiss", onDismiss: () => {} }} />,
    );
    expect(html).toContain('data-testid="remote-outdated"');
    expect(html).toContain("This version can&#x27;t connect");
    expect(html).toContain(">Update<");
    expect(html).toContain('aria-label="Dismiss"');
  });
});
