/**
 * The requests a browser tab's pages made: how the Network events make
 * entries.
 */
import { describe, expect, test } from "bun:test";
import {
  NETWORK_LIMIT,
  NetworkLog,
} from "../../../../../src/main/features/cli/browser/network-log";

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
