/** Which NexusCode server the app signs in to. */
import { describe, expect, test } from "bun:test";
import { DEV_SERVER, remoteServer, SERVER } from "../../../../../src/main/features/remote/server";

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
});
