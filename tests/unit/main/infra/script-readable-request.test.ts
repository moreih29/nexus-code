import { describe, expect, test } from "bun:test";
import { isScriptReadableRequest } from "../../../../src/main/infra/security/script-readable-request";

describe("isScriptReadableRequest", () => {
  const workspace = (rel: string) => `nexus-workspace://ws-1/${rel}`;
  const file = (abs: string) => `file://${abs}`;

  test("lets subresources a page renders with load", () => {
    expect(isScriptReadableRequest("image", workspace("logo.png"))).toBe(false);
    expect(isScriptReadableRequest("font", workspace("fonts/Inter.woff2"))).toBe(false);
    expect(isScriptReadableRequest("stylesheet", workspace("style.css"))).toBe(false);
    expect(isScriptReadableRequest("subFrame", workspace("other.html"))).toBe(false);
    expect(isScriptReadableRequest("script", workspace("app/main.mjs?v=2"))).toBe(false);
    expect(isScriptReadableRequest("mainFrame", file("/Users/u/site/index.html"))).toBe(false);
    expect(isScriptReadableRequest("script", file("/Users/u/site/app.js"))).toBe(false);
  });

  test("cancels loads whose bytes page script could read", () => {
    expect(isScriptReadableRequest("xhr", workspace(".env"))).toBe(true);
    expect(isScriptReadableRequest("xhr", workspace("app/main.js"))).toBe(true);
    // JSON modules arrive as script requests.
    expect(isScriptReadableRequest("script", workspace("data/config.json"))).toBe(true);
    expect(isScriptReadableRequest("script", workspace(".env"))).toBe(true);
    expect(isScriptReadableRequest("xhr", file("/Users/u/.ssh/id_rsa"))).toBe(true);
    expect(isScriptReadableRequest("script", file("/Users/u/.aws/credentials"))).toBe(true);
  });
});
