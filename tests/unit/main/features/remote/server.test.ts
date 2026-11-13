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
    expect(remoteServer({ NEXUS_REMOTE_SERVER: "" }, true)).toBe(SERVER);
  });
});
