import { describe, expect, it } from "bun:test";
import net from "node:net";
import { createSshChannel } from "../../../../src/main/transport/ssh-channel";
import { spawnNodeBackedPty } from "./node-pty-spawn";

const FIXTURE_HOST = "127.0.0.1";
const FIXTURE_PORT = 2223;
const FIXTURE_USER = process.env.NEXUS_SSH_FIXTURE_USER ?? "nexus";
const FIXTURE_PASSWORD = process.env.NEXUS_SSH_FIXTURE_PASSWORD ?? "password";

describe("ssh PTY auth linux-password fixture", () => {
  it("authenticates once and reaches ready over a reused ControlMaster socket", async () => {
    if (process.env.NEXUS_RUN_SSH_PTY_FIXTURE !== "1") {
      console.warn("Skipping ssh PTY auth fixture test: set NEXUS_RUN_SSH_PTY_FIXTURE=1 to opt in");
      return;
    }
    if (!(await isPortOpen(FIXTURE_HOST, FIXTURE_PORT))) {
      console.warn("Skipping ssh PTY auth fixture test: 127.0.0.1:2223 is unavailable");
      return;
    }

    const channel = createSshChannel(
      {
        host: FIXTURE_HOST,
        user: FIXTURE_USER,
        port: FIXTURE_PORT,
        authMode: "interactive",
        remoteCommand: `printf '{"type":"ready","protocolVersion":"1.0.0"}\\n'; cat >/dev/null`,
      },
      {
        promptHandler: async (prompt) => {
          if (prompt.kind === "host-key")
            return { kind: "host-key", promptId: prompt.promptId, trust: "yes" };
          return { kind: "password", promptId: prompt.promptId, value: FIXTURE_PASSWORD };
        },
        auth: { spawnPty: spawnNodeBackedPty, authTimeoutMs: 10_000 },
        requestTimeoutMs: 5_000,
      },
    );

    try {
      await expect(channel.ready).resolves.toBeUndefined();
    } finally {
      channel.dispose();
    }
  });
});

function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(250);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
