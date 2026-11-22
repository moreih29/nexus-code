/** Which NexusCode server the app signs in to, and the addresses it reaches it at. */
import { describe, expect, test } from "bun:test";
import {
  DEV_SERVER,
  DIRECT,
  FALLBACK,
  PROXY,
  remoteServer,
  remoteWays,
  SERVER,
} from "../../../../../src/main/features/remote/server";

describe("the server", () => {
  test("the released app's is the deployed one, development's the local one", () => {
    expect(remoteServer({}, true)).toBe(SERVER);
    expect(SERVER).toBe("https://nexus-cloud.moreih29.workers.dev");
    expect(remoteServer({}, false)).toBe(DEV_SERVER);
  });

  test("NEXUS_REMOTE_SERVER names another either way", () => {
    expect(remoteServer({ NEXUS_REMOTE_SERVER: " http://localhost:9000 " }, true)).toBe(
      "http://localhost:9000",
    );
    expect(remoteServer({ NEXUS_REMOTE_SERVER: "https://staging.example.com" }, true)).toBe(
      "https://staging.example.com",
    );
    expect(remoteServer({ NEXUS_REMOTE_SERVER: "" }, true)).toBe(SERVER);
  });

  test("the released app takes another only over https, or http on this machine", () => {
    const warned: string[] = [];
    const warn = (message: string) => warned.push(message);
    for (const value of ["http://evil.example.com", "http://localhost.evil.com", "ftp://x", "x"]) {
      expect(remoteServer({ NEXUS_REMOTE_SERVER: value }, true, warn)).toBe(SERVER);
    }
    expect(warned).toHaveLength(4);
    // Development takes what it is given.
    expect(remoteServer({ NEXUS_REMOTE_SERVER: "http://192.168.0.5:8787" }, false)).toBe(
      "http://192.168.0.5:8787",
    );
  });

  test("the released app's server is a name; its requests go to the domain's addresses", () => {
    const ways = remoteWays({}, true, SERVER);
    expect(ways).toEqual({ proxy: PROXY, direct: DIRECT, fallback: FALLBACK });
    expect(new URL(PROXY).host).toBe("api.nexuscode.gradiendo.com");
    expect(new URL(DIRECT).host).toBe("cloud.nexuscode.gradiendo.com");
    // The name it signs in to answers still, last.
    expect(FALLBACK).toBe(SERVER);
    // An environment does not name the released app's proxy.
    expect(remoteWays({ NEXUS_REMOTE_PROXY: "https://evil.example.com" }, true, SERVER)).toEqual(
      ways,
    );
  });

  test("another server is reached at its own address alone", () => {
    expect(remoteWays({}, true, "https://staging.example.com")).toEqual({
      proxy: null,
      direct: "https://staging.example.com",
      fallback: null,
    });
    expect(remoteWays({}, false, DEV_SERVER)).toEqual({
      proxy: null,
      direct: DEV_SERVER,
      fallback: null,
    });
  });

  test("development goes straight unless NEXUS_REMOTE_PROXY names one", () => {
    expect(remoteWays({ NEXUS_REMOTE_PROXY: " " }, false, DEV_SERVER).proxy).toBeNull();
    expect(remoteWays({ NEXUS_REMOTE_PROXY: "http://localhost:9999" }, false, DEV_SERVER)).toEqual({
      proxy: "http://localhost:9999",
      direct: DEV_SERVER,
      fallback: null,
    });
  });
});
