import { describe, expect, test } from "bun:test";
import {
  cancelsAppSchemeRequest,
  cancelsEmbeddedRequest,
  cancelsFrameLoad,
  isEmbeddedFrame,
} from "../../../../src/main/features/custom-protocols/app-schemes";
import { allowsEmbeddedNavigation } from "../../../../src/main/features/window/frame-navigation";

const SCOPE = `nexus-workspace://${"a".repeat(32)}.scope`;
const top = { parent: null };
const preview = { parent: top };

describe("what a preview frame may ask for", () => {
  test("only frames under the app's page count as previews", () => {
    expect(isEmbeddedFrame(top)).toBe(false);
    expect(isEmbeddedFrame(preview)).toBe(true);
    expect(isEmbeddedFrame({ parent: preview })).toBe(true);
    expect(isEmbeddedFrame(null)).toBe(false);
  });

  test("loads its own folder, and reads it too", () => {
    for (const type of ["image", "stylesheet", "script", "font", "media", "xhr"]) {
      expect(cancelsEmbeddedRequest(type, `${SCOPE}/a.png`)).toBe(false);
    }
    expect(cancelsAppSchemeRequest("xhr", `${SCOPE}/data.csv`)).toBe(false);
    expect(cancelsAppSchemeRequest("script", `${SCOPE}/app.js`)).toBe(false);
  });

  test("never a workspace file, an outside grant or another device's file directly", () => {
    for (const url of [
      "nexus-workspace://ws/src/a.png",
      "nexus-workspace://ws.outside/Users/me/.ssh/id_rsa",
      "nexus-workspace://peer/dev/ws/Users/me/a.png",
      "nexus-workspace://not-a-scope.scope/a.png",
    ]) {
      expect(cancelsEmbeddedRequest("image", url)).toBe(true);
    }
    expect(cancelsAppSchemeRequest("xhr", "nexus-workspace://ws.outside/Users/me/a.txt")).toBe(
      true,
    );
  });

  test("loads from https, but sends nothing it could read back, and nothing over http", () => {
    for (const type of ["image", "stylesheet", "script", "font", "media"]) {
      expect(cancelsEmbeddedRequest(type, "https://cdn.test/x")).toBe(false);
      expect(cancelsEmbeddedRequest(type, "http://cdn.test/x")).toBe(true);
    }
    for (const type of ["xhr", "webSocket", "ping", "cspReport", "object", "subFrame", "other"]) {
      expect(cancelsEmbeddedRequest(type, "https://x.test/")).toBe(true);
    }
    expect(cancelsEmbeddedRequest("webSocket", "wss://x.test/")).toBe(true);
    expect(cancelsEmbeddedRequest("image", "file:///etc/passwd")).toBe(true);
  });
});

describe("where a preview frame may go", () => {
  test("the app may put a preview document in its frame", () => {
    expect(allowsEmbeddedNavigation(`nexus-preview://${"0".repeat(32)}/`, top)).toBe(true);
    expect(allowsEmbeddedNavigation(`nexus-preview://${"0".repeat(32)}/`)).toBe(true);
    expect(allowsEmbeddedNavigation("about:blank", top)).toBe(true);
  });

  test("the page may not move its own frame anywhere, and the app sends it nowhere else", () => {
    expect(allowsEmbeddedNavigation(`nexus-preview://${"1".repeat(32)}/`, preview)).toBe(false);
    expect(allowsEmbeddedNavigation("https://x.test/?d=secret", preview)).toBe(false);
    expect(allowsEmbeddedNavigation("https://x.test/", top)).toBe(false);
    expect(allowsEmbeddedNavigation(`${SCOPE}/index.html`, top)).toBe(false);
    expect(allowsEmbeddedNavigation("nexus-workspace://ws.outside/Users/me/a.html", top)).toBe(
      false,
    );
    expect(allowsEmbeddedNavigation("about:srcdoc", preview)).toBe(false);
  });
});

describe("what any frame of the app's window may load", () => {
  test("only a preview document, whoever asks: a page moving itself away is stopped here", () => {
    expect(cancelsFrameLoad("subFrame", `nexus-preview://${"0".repeat(32)}/`)).toBe(false);
    expect(cancelsFrameLoad("subFrame", "about:blank")).toBe(false);
    for (const url of [
      "https://x.test/?leak=1",
      "http://x.test/",
      `${SCOPE}/index.html`,
      "nexus-workspace://ws.outside/Users/me/a.html",
      "file:///etc/passwd",
    ]) {
      expect(cancelsFrameLoad("subFrame", url)).toBe(true);
    }
    expect(cancelsFrameLoad("image", "https://x.test/a.png")).toBe(false);
  });
});
