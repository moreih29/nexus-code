import { describe, expect, test } from "bun:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Session } from "electron";
import {
  appContentSecurityPolicy,
  appPageUrlPatterns,
  cancelsAppFileRequest,
  installAppCsp,
  isAppPageUrl,
} from "../../../../../src/main/features/window/app-csp";

const INDEX = path.resolve("/app/out/renderer/index.html");
const INDEX_URL = pathToFileURL(INDEX).href;
const DEV = "http://localhost:41234";

/** The policy's directives, by name. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(";").map((part) => {
      const [name = "", ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

describe("appContentSecurityPolicy", () => {
  test("runs only the app's own scripts in a build, and embeds only its preview frames", () => {
    const policy = directives(appContentSecurityPolicy());
    expect(policy.get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(policy.get("default-src")).toEqual(["'self'"]);
    expect(policy.get("frame-src")).toEqual(["nexus-preview:", "nexus-workspace:"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'none'"]);
    expect(policy.get("connect-src")).not.toContain("https:");
    expect(appContentSecurityPolicy()).not.toContain("'unsafe-eval'");
  });

  test("lets the dev server's inline preamble and HMR socket through in dev only", () => {
    const policy = directives(appContentSecurityPolicy(DEV));
    expect(policy.get("script-src")).toContain("'unsafe-inline'");
    expect(policy.get("connect-src")).toContain("ws://localhost:*");
    expect(directives(appContentSecurityPolicy()).get("script-src")).not.toContain(
      "'unsafe-inline'",
    );
  });
});

describe("isAppPageUrl", () => {
  test("takes the renderer's index.html in a build, and nothing else", () => {
    const page = { indexPath: INDEX };
    expect(isAppPageUrl(INDEX_URL, page)).toBe(true);
    expect(isAppPageUrl(pathToFileURL(path.resolve("/app/out/other.html")).href, page)).toBe(false);
    expect(isAppPageUrl(`${DEV}/`, page)).toBe(false);
    expect(isAppPageUrl("not a url", page)).toBe(false);
  });

  test("takes the dev server's pages in dev", () => {
    const page = { indexPath: INDEX, devServerUrl: `${DEV}/` };
    expect(isAppPageUrl(`${DEV}/`, page)).toBe(true);
    expect(isAppPageUrl(`${DEV}/index.html?t=1`, page)).toBe(true);
    expect(isAppPageUrl("http://localhost:5173/", page)).toBe(false);
    expect(isAppPageUrl(INDEX_URL, page)).toBe(false);
  });

  test("filters webRequest to file:// in a build and to the dev server in dev", () => {
    expect(appPageUrlPatterns({ indexPath: INDEX })).toEqual(["file:///*"]);
    expect(appPageUrlPatterns({ indexPath: INDEX, devServerUrl: `${DEV}/` })).toEqual([`${DEV}/*`]);
  });
});

describe("cancelsAppFileRequest", () => {
  const RENDERER = path.dirname(INDEX);
  const inRenderer = (rel: string) => pathToFileURL(path.join(RENDERER, rel)).href;
  const repo = pathToFileURL(path.resolve("/Users/u/repo/evil.js")).href;

  test("runs and reads only the renderer's own files", () => {
    for (const type of [
      "script",
      "stylesheet",
      "subFrame",
      "object",
      "xhr",
      "other",
      "mainFrame",
    ]) {
      expect(cancelsAppFileRequest(type, repo, RENDERER)).toBe(true);
      expect(cancelsAppFileRequest(type, inRenderer("assets/index-abc.js"), RENDERER)).toBe(false);
    }
    expect(cancelsAppFileRequest("script", inRenderer("monaco/vs/loader.js"), RENDERER)).toBe(
      false,
    );
    expect(cancelsAppFileRequest("mainFrame", INDEX_URL, RENDERER)).toBe(false);
  });

  test("lets what only renders through from anywhere", () => {
    for (const type of ["image", "font", "media"]) {
      expect(cancelsAppFileRequest(type, repo, RENDERER)).toBe(false);
    }
  });

  test("is not fooled by a way out of the folder, or a folder of a like name", () => {
    const parent = `${pathToFileURL(RENDERER).href}/../main/index.js`;
    expect(cancelsAppFileRequest("script", parent, RENDERER)).toBe(true);
    const encoded = `${pathToFileURL(RENDERER).href}/%2e%2e/main/index.js`;
    expect(cancelsAppFileRequest("script", encoded, RENDERER)).toBe(true);
    const sibling = pathToFileURL(`${RENDERER}-evil${path.sep}x.js`).href;
    expect(cancelsAppFileRequest("script", sibling, RENDERER)).toBe(true);
    expect(cancelsAppFileRequest("xhr", pathToFileURL(RENDERER).href, RENDERER)).toBe(true);
    expect(cancelsAppFileRequest("script", "file://other-host/share/x.js", RENDERER)).toBe(true);
    expect(cancelsAppFileRequest("script", "not a url", RENDERER)).toBe(true);
  });

  test.if(process.platform === "win32")("takes the folder in any case on Windows", () => {
    const upper = pathToFileURL(path.join(RENDERER.toUpperCase(), "assets", "a.js")).href;
    expect(cancelsAppFileRequest("script", upper, RENDERER)).toBe(false);
  });
});

type HeadersListener = (
  details: { url: string; resourceType: string; responseHeaders?: Record<string, string[]> },
  callback: (response: { responseHeaders?: Record<string, string[]> }) => void,
) => void;

function install(reportOnly = false) {
  let listener: HeadersListener | undefined;
  let filter: { urls: string[] } | undefined;
  const session = {
    webRequest: {
      onHeadersReceived: (f: { urls: string[] }, l: HeadersListener) => {
        filter = f;
        listener = l;
      },
    },
  } as unknown as Session;
  installAppCsp(session, { indexPath: INDEX }, reportOnly);
  if (!listener) throw new Error("listener not installed");
  const run = listener;
  const respond = (url: string, resourceType: string, responseHeaders = {}) => {
    let response: { responseHeaders?: Record<string, string[]> } | undefined;
    run({ url, resourceType, responseHeaders }, (r) => {
      response = r;
    });
    return response;
  };
  return { respond, filter };
}

describe("installAppCsp", () => {
  test("sends the policy with the app's page, in place of one the response had", () => {
    const { respond, filter } = install();
    expect(filter).toEqual({ urls: ["file:///*"] });
    const headers = respond(INDEX_URL, "mainFrame", {
      "content-security-policy": ["default-src *"],
      "Content-Type": ["text/html"],
    })?.responseHeaders;
    expect(headers?.["Content-Security-Policy"]).toEqual([appContentSecurityPolicy()]);
    expect(headers?.["content-security-policy"]).toBeUndefined();
    expect(headers?.["Content-Type"]).toEqual(["text/html"]);
  });

  test("leaves every other response as it is", () => {
    const { respond } = install();
    expect(respond(INDEX_URL, "script")).toEqual({});
    const other = pathToFileURL(path.resolve("/Users/u/page.html")).href;
    expect(respond(other, "mainFrame")).toEqual({});
  });

  test("only reports in Report-Only", () => {
    const { respond } = install(true);
    const headers = respond(INDEX_URL, "mainFrame")?.responseHeaders;
    expect(headers?.["Content-Security-Policy-Report-Only"]).toEqual([appContentSecurityPolicy()]);
    expect(headers?.["Content-Security-Policy"]).toBeUndefined();
  });
});
