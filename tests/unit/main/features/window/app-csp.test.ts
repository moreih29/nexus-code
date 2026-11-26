import { describe, expect, test } from "bun:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Session } from "electron";
import {
  installAppRequestGuard,
  type RequestFrame,
} from "../../../../../src/main/features/custom-protocols/app-schemes";
import {
  appContentSecurityPolicy,
  appPageUrlPatterns,
  cancelsAppFileRequest,
  isAppPageUrl,
} from "../../../../../src/main/features/window/app-csp";

const INDEX = path.resolve("/app/out/renderer/index.html");
const INDEX_URL = pathToFileURL(INDEX).href;
const DEV = "http://localhost:41234";

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
    expect(policy.get("frame-src")).toEqual(["nexus-preview:"]);
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

interface RequestDetails {
  id: number;
  url: string;
  resourceType: string;
  frame?: RequestFrame | null;
}

type Listener<Details, Response> = (
  details: Details,
  callback: (response: Response) => void,
) => void;

function dispatch<Details, Response>(listener: Listener<Details, Response>, details: Details) {
  const responses: Response[] = [];
  listener(details, (response) => responses.push(response));
  expect(responses).toHaveLength(1);
  return responses[0];
}

function install(reportOnly = false) {
  type ResponseHeaders = Record<string, string[]>;
  type RequestHeaders = Record<string, string>;
  let onRequest: Listener<RequestDetails, { cancel: boolean }> | undefined;
  let onSend:
    | Listener<
        RequestDetails & { requestHeaders: RequestHeaders },
        { requestHeaders?: RequestHeaders }
      >
    | undefined;
  let onResponse:
    | Listener<
        RequestDetails & { responseHeaders?: ResponseHeaders },
        { responseHeaders?: ResponseHeaders }
      >
    | undefined;
  let onCompleted: ((details: { id: number }) => void) | undefined;
  let onError: ((details: { id: number }) => void) | undefined;
  let filter: { urls: string[] } | undefined;
  const session = {
    webRequest: {
      onBeforeRequest: (_filter: unknown, listener: typeof onRequest) => {
        onRequest = listener;
      },
      onBeforeSendHeaders: (_filter: unknown, listener: typeof onSend) => {
        onSend = listener;
      },
      onHeadersReceived: (responseFilter: { urls: string[] }, listener: typeof onResponse) => {
        filter = responseFilter;
        onResponse = listener;
      },
      onCompleted: (listener: typeof onCompleted) => {
        onCompleted = listener;
      },
      onErrorOccurred: (listener: typeof onError) => {
        onError = listener;
      },
    },
  } as unknown as Session;
  installAppRequestGuard(session, { indexPath: INDEX }, reportOnly);
  if (!onRequest || !onSend || !onResponse || !onCompleted || !onError) {
    throw new Error("request guard not installed");
  }
  return {
    filter,
    onRequest,
    onSend,
    onResponse,
    onCompleted,
    onError,
  };
}

describe("app response policy", () => {
  test("sends the policy with the app's page, in place of one the response had", () => {
    const { onResponse, filter } = install();
    expect(filter).toEqual({ urls: ["file:///*", "https://*/*"] });
    const headers = dispatch(onResponse, {
      id: 1,
      url: INDEX_URL,
      resourceType: "mainFrame",
      responseHeaders: {
        "content-security-policy": ["default-src *"],
        "Content-Type": ["text/html"],
      },
    })?.responseHeaders;
    expect(headers?.["Content-Security-Policy"]).toEqual([appContentSecurityPolicy()]);
    expect(headers?.["content-security-policy"]).toBeUndefined();
    expect(headers?.["Content-Type"]).toEqual(["text/html"]);
  });

  test("leaves every other response as it is", () => {
    const { onResponse } = install();
    expect(dispatch(onResponse, { id: 1, url: INDEX_URL, resourceType: "script" })).toEqual({});
    const other = pathToFileURL(path.resolve("/Users/u/page.html")).href;
    expect(dispatch(onResponse, { id: 2, url: other, resourceType: "mainFrame" })).toEqual({});
  });

  test("only reports in Report-Only", () => {
    const { onResponse } = install(true);
    const headers = dispatch(onResponse, {
      id: 1,
      url: INDEX_URL,
      resourceType: "mainFrame",
    })?.responseHeaders;
    expect(headers?.["Content-Security-Policy-Report-Only"]).toEqual([appContentSecurityPolicy()]);
    expect(headers?.["Content-Security-Policy"]).toBeUndefined();
  });
});

describe("preview cookies", () => {
  const top = { parent: null };
  const image = { id: 1, url: "https://cdn.test/image.png", resourceType: "image" };
  const responseHeaders = {
    "Set-Cookie": ["one=1", "two=2"],
    "sEt-CoOkIe": ["three=3"],
    Location: ["https://cdn.test/redirected.png"],
    "Cache-Control": ["public, max-age=3600"],
  };

  test("removes cookies on both legs of a redirect even if the preview frame disappears", () => {
    const { onRequest, onSend, onResponse } = install();
    expect(dispatch(onRequest, { ...image, frame: { parent: top } })).toEqual({ cancel: false });
    const requestHeaders = { cOoKiE: "one=1", Accept: "image/*" };
    expect(dispatch(onSend, { ...image, frame: null, requestHeaders })).toEqual({
      requestHeaders: { Accept: "image/*" },
    });
    expect(dispatch(onResponse, { ...image, frame: null, responseHeaders })).toEqual({
      responseHeaders: {
        Location: responseHeaders.Location,
        "Cache-Control": ["public, max-age=3600"],
      },
    });
    const redirect = { ...image, url: responseHeaders.Location[0]!, frame: null };
    expect(dispatch(onRequest, redirect)).toEqual({ cancel: false });
    expect(
      dispatch(onResponse, { ...redirect, responseHeaders: { "set-cookie": ["four=4"] } }),
    ).toEqual({ responseHeaders: {} });
  });

  test("preserves headers on app and frame-less requests", () => {
    const { onRequest, onSend, onResponse } = install();
    for (const frame of [top, null]) {
      const request = { ...image, frame };
      expect(dispatch(onRequest, request)).toEqual({ cancel: false });
      expect(dispatch(onSend, { ...request, requestHeaders: { Cookie: "one=1" } })).toEqual({});
      expect(dispatch(onResponse, { ...request, responseHeaders })).toEqual({});
    }
  });

  test("releases tracked requests on completion and failure", () => {
    const { onRequest, onResponse, onCompleted, onError } = install();
    for (const finish of [onCompleted, onError]) {
      dispatch(onRequest, { ...image, frame: { parent: top } });
      expect(dispatch(onResponse, image)).toEqual({});
      finish(image);
      expect(dispatch(onResponse, { ...image, responseHeaders })).toEqual({});
    }
  });
});
