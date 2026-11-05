/**
 * The requests a browser tab's pages made: how the Network events make
 * entries, and what nexus browser network prints of them.
 */
import { describe, expect, test } from "bun:test";
import type { RequestDetails } from "../../../../../src/main/features/cli/browser/driver";
import {
  NETWORK_LIMIT,
  type NetworkEntry,
  NetworkLog,
} from "../../../../../src/main/features/cli/browser/network-log";
import { CLI_COMMANDS } from "../../../../../src/main/features/cli/commands";
import { clockTime } from "../../../../../src/main/features/cli/commands/browser-control";
import { runCli } from "../../../../../src/main/features/cli/registry";
import { APP, BROWSER_TAB, contextFor, type FakeApp, fakeApp, SHELL_TAB } from "../fake-services";

function sent(log: NetworkLog, requestId: string, url: string, extra: object = {}) {
  log.handle("Network.requestWillBeSent", {
    requestId,
    timestamp: 10,
    wallTime: 1_700_000_000,
    type: "Fetch",
    request: { url, method: "GET", headers: { accept: "*/*" } },
    ...extra,
  });
}

describe("NetworkLog", () => {
  test("a request takes its response, size and time as they come", () => {
    const log = new NetworkLog();
    sent(log, "r1", "http://localhost:5173/api/user", {
      request: {
        url: "http://localhost:5173/api/user",
        method: "POST",
        headers: { "content-type": "application/json" },
        postData: '{"name":"me"}',
      },
    });
    log.handle("Network.responseReceived", {
      requestId: "r1",
      response: {
        status: 201,
        statusText: "Created",
        mimeType: "application/json",
        headers: { a: 1 },
      },
    });
    log.handle("Network.loadingFinished", {
      requestId: "r1",
      timestamp: 10.045,
      encodedDataLength: 88,
    });
    expect(log.read(false)).toEqual([
      {
        id: 1,
        at: 1_700_000_000_000,
        method: "POST",
        url: "http://localhost:5173/api/user",
        type: "fetch",
        requestHeaders: { "content-type": "application/json" },
        hasPostData: true,
        postData: '{"name":"me"}',
        status: 201,
        statusText: "Created",
        mimeType: "application/json",
        responseHeaders: { a: "1" },
        ms: 45,
        size: 88,
      },
    ]);
    expect(log.find(1)?.requestId).toBe("r1");
    expect(log.find(2)).toBeUndefined();
  });

  test("a redirect ends one entry and starts the next under the same request", () => {
    const log = new NetworkLog();
    sent(log, "r1", "http://a.test/old");
    sent(log, "r1", "http://a.test/new", {
      timestamp: 10.01,
      redirectResponse: { status: 302, statusText: "Found", headers: {} },
    });
    log.handle("Network.loadingFailed", {
      requestId: "r1",
      timestamp: 10.02,
      errorText: "net::ERR_FAILED",
    });
    const [old, next] = log.read(false);
    expect(old).toMatchObject({ id: 1, status: 302, redirectedTo: "http://a.test/new", ms: 10 });
    expect(next).toMatchObject({
      id: 2,
      url: "http://a.test/new",
      failure: "net::ERR_FAILED",
      ms: 10,
    });
  });

  test("leaves out data URLs, marks cancels and the cache, keeps the last ones, and clears", () => {
    const log = new NetworkLog();
    sent(log, "d", "data:image/png;base64,AAAA");
    sent(log, "c", "http://a.test/x");
    log.handle("Network.requestServedFromCache", { requestId: "c" });
    log.handle("Network.loadingFailed", { requestId: "c", timestamp: 11, canceled: true });
    expect(log.read(false)).toMatchObject([{ id: 1, cached: true, failure: "canceled" }]);
    for (let i = 0; i < NETWORK_LIMIT + 5; i++) sent(log, `n${i}`, `http://a.test/${i}`);
    const kept = log.read(true);
    expect(kept.length).toBe(NETWORK_LIMIT);
    expect(kept[0]?.url).toBe("http://a.test/5");
    expect(log.read(false)).toEqual([]);
  });
});

async function nexus(app: FakeApp, argv: string[]) {
  return runCli(CLI_COMMANDS, contextFor(app, argv, { workspaceId: APP, tabId: SHELL_TAB }));
}

const AT = 1_700_000_000_000;

function entry(id: number, fields: Partial<NetworkEntry>): NetworkEntry {
  return {
    id,
    at: AT,
    method: "GET",
    url: `http://localhost:5173/${id}`,
    type: "fetch",
    requestHeaders: {},
    hasPostData: false,
    ...fields,
  };
}

describe("nexus browser network", () => {
  test("lists the tab's requests, failed ones with why", async () => {
    const app = fakeApp();
    app.browser.network = [
      entry(1, {
        type: "document",
        url: "http://localhost:5173/",
        status: 200,
        size: 1234,
        ms: 30,
      }),
      entry(2, {
        method: "POST",
        url: "http://localhost:5173/api/login",
        status: 500,
        size: 88,
        ms: 120,
      }),
      entry(3, {
        type: "script",
        url: "http://cdn.test/app.js",
        failure: "net::ERR_NAME_NOT_RESOLVED",
        ms: 5,
      }),
      entry(4, { url: "http://localhost:5173/api/slow" }),
    ];
    const t = clockTime(AT);
    expect((await nexus(app, ["browser", "network"])).stdout).toBe(
      [
        "#  TIME      METHOD  STATUS  TYPE      SIZE    MS   URL",
        `1  ${t}  GET     200     document  1.2 kB  30   http://localhost:5173/`,
        `2  ${t}  POST    500     fetch     88 B    120  http://localhost:5173/api/login`,
        `3  ${t}  GET     failed  script    -       5    http://cdn.test/app.js  (net::ERR_NAME_NOT_RESOLVED)`,
        `4  ${t}  GET     …       fetch     -       -    http://localhost:5173/api/slow`,
        "",
      ].join("\n"),
    );
    expect(app.browser.calls).toEqual([{ op: "network", tabId: BROWSER_TAB, args: [false] }]);

    const failed = await nexus(app, ["browser", "network", "--failed", "--type", "fetch,xhr"]);
    expect(failed.stdout).toContain("api/login");
    expect(failed.stdout).not.toContain("app.js");
    const last = await nexus(app, [
      "browser",
      "network",
      "--url",
      "/api/",
      "--last",
      "1",
      "--clear",
    ]);
    expect(last.stdout.split("\n")[0]).toBe("… 1 earlier; see them with --last");
    expect(last.stdout).toContain("api/slow");
    expect(app.browser.calls.at(-1)?.args).toEqual([true]);
    app.browser.network = [];
    expect((await nexus(app, ["browser", "network"])).stdout).toBe("No requests.\n");
  });

  test("shows one request's headers, what was sent and what came back", async () => {
    const app = fakeApp();
    const login: RequestDetails = {
      entry: entry(2, {
        method: "POST",
        url: "http://localhost:5173/api/login",
        status: 500,
        statusText: "Internal Server Error",
        mimeType: "application/json",
        size: 88,
        ms: 120,
        requestHeaders: { "content-type": "application/json" },
        hasPostData: true,
        responseHeaders: { "x-id": "7" },
      }),
      postData: '{"user":"me"}',
      body: { kind: "text", text: '{"error":', length: 16 },
    };
    app.browser.requests = {
      2: login,
      3: { entry: entry(3, {}), body: { kind: "none", why: "it has not finished" } },
    };
    expect((await nexus(app, ["browser", "network", "#2", "--body", "9"])).stdout).toBe(
      [
        "#2 POST http://localhost:5173/api/login",
        "500 Internal Server Error · fetch · application/json · 88 B · 120ms",
        "",
        "Request headers:",
        "  content-type: application/json",
        "",
        "Sent:",
        '  {"user":"me"}',
        "",
        "Response headers:",
        "  x-id: 7",
        "",
        "Response (first 9 of 16 characters; more with --body):",
        '  {"error":',
        "",
      ].join("\n"),
    );
    expect(app.browser.calls.at(-1)).toEqual({ op: "request", tabId: BROWSER_TAB, args: [2, 9] });
    expect((await nexus(app, ["browser", "network", "3"])).stdout).toContain(
      "No response body: it has not finished.",
    );
    expect((await nexus(app, ["browser", "network", "9"])).stderr).toContain("no request 9");
    expect((await nexus(app, ["browser", "network", "x"])).stderr).toContain(
      'a request is a number from the list, not "x"',
    );
  });
});
