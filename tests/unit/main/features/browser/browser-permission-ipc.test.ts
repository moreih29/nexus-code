import { describe, expect, test } from "bun:test";
import { isLoadableFaviconUrl } from "../../../../../src/main/features/browser/ipc";

// Regression: the tab bar loads page-supplied favicons from the app's own
// session, so a page could point it at file:// or nexus-workspace://.
describe("isLoadableFaviconUrl", () => {
  test("accepts web and inline image favicons", () => {
    expect(isLoadableFaviconUrl("https://example.com/favicon.ico")).toBe(true);
    expect(isLoadableFaviconUrl("http://localhost:3000/icon.png")).toBe(true);
    expect(isLoadableFaviconUrl("data:image/png;base64,AAAA")).toBe(true);
  });

  test("rejects schemes only the app session can reach", () => {
    expect(isLoadableFaviconUrl("file:///Users/u/.ssh/id_rsa")).toBe(false);
    expect(isLoadableFaviconUrl("nexus-workspace://ws-1/.env")).toBe(false);
    expect(isLoadableFaviconUrl("data:text/html,<script>")).toBe(false);
  });
});
