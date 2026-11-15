/** Which NexusCode server the app signs in to. */
import { describe, expect, test } from "bun:test";
import {
  DEV_SERVER,
  PROXY,
  remoteProxy,
  remoteServer,
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

  test("the released app goes to its own server through the proxy, to another straight", () => {
    expect(remoteProxy({}, true, SERVER)).toBe(PROXY);
    expect(PROXY).toBe("https://13-124-109-101.sslip.io");
    expect(remoteProxy({}, true, "https://staging.example.com")).toBeNull();
    // An environment does not name the released app's proxy.
    expect(remoteProxy({ NEXUS_REMOTE_PROXY: "https://evil.example.com" }, true, SERVER)).toBe(
      PROXY,
    );
  });

  test("development goes straight unless NEXUS_REMOTE_PROXY names one", () => {
    expect(remoteProxy({}, false, DEV_SERVER)).toBeNull();
    expect(remoteProxy({ NEXUS_REMOTE_PROXY: " " }, false, DEV_SERVER)).toBeNull();
    expect(remoteProxy({ NEXUS_REMOTE_PROXY: "http://localhost:9999" }, false, DEV_SERVER)).toBe(
      "http://localhost:9999",
    );
  });
});
