import { describe, expect, test } from "bun:test";
import { isAllowedMainWindowNavigation } from "../../../../../src/main/features/window/navigation";

const DEV = "http://localhost:5173";

describe("isAllowedMainWindowNavigation", () => {
  test("blocks every navigation without a dev server", () => {
    expect(isAllowedMainWindowNavigation("http://localhost:5173/", undefined)).toBe(false);
    expect(isAllowedMainWindowNavigation("file:///app/renderer/index.html", undefined)).toBe(false);
  });

  test("allows the dev server reloading its own page", () => {
    expect(isAllowedMainWindowNavigation("http://localhost:5173/", DEV)).toBe(true);
    expect(isAllowedMainWindowNavigation("http://localhost:5173/index.html?t=1", `${DEV}/`)).toBe(
      true,
    );
  });

  test("blocks other origins in dev", () => {
    expect(isAllowedMainWindowNavigation("https://example.com/", DEV)).toBe(false);
    expect(isAllowedMainWindowNavigation("http://localhost:5174/", DEV)).toBe(false);
    expect(isAllowedMainWindowNavigation("https://localhost:5173/", DEV)).toBe(false);
    expect(isAllowedMainWindowNavigation("http://localhost:5173.evil.test/", DEV)).toBe(false);
    expect(isAllowedMainWindowNavigation("file:///etc/passwd", DEV)).toBe(false);
  });

  test("blocks everything when a URL does not parse or has an opaque origin", () => {
    expect(isAllowedMainWindowNavigation("not a url", DEV)).toBe(false);
    expect(isAllowedMainWindowNavigation("file:///a", "file:///a")).toBe(false);
  });
});
