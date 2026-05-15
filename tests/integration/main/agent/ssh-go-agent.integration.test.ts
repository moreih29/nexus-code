import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import { SshFsProvider } from "../../../../src/main/features/fs/bridge/ssh-provider";
import {
  LOCAL_AGENT_DIST_DIR,
  ensureRemoteAgent,
} from "../../../../src/main/infra/agent/ssh/ssh-bootstrap/index";
import { createSshChannel } from "../../../../src/main/infra/agent/ssh/ssh-channel";
import { spawnNodeBackedPty } from "./node-pty-spawn";

const FIXTURE_HOST = "127.0.0.1";
const FIXTURE_PORT = 2223;
const FIXTURE_USER = process.env.NEXUS_SSH_FIXTURE_USER ?? "nexus-dev";
const FIXTURE_PASSWORD = process.env.NEXUS_SSH_FIXTURE_PASSWORD ?? "nexus-dev";
const FIXTURE_REMOTE_PATH = process.env.NEXUS_SSH_FIXTURE_REMOTE_PATH ?? "/home/nexus-dev/workspace";

describe("ssh Go agent linux-password fixture", () => {
  it("bootstraps agent and serves fs operations through SshFsProvider", async () => {
    if (process.env.NEXUS_RUN_SSH_GO_FIXTURE !== "1") {
      console.warn("Skipping ssh Go agent fixture test: set NEXUS_RUN_SSH_GO_FIXTURE=1 to opt in");
      return;
    }
    if (!(await isPortOpen(FIXTURE_HOST, FIXTURE_PORT))) {
      console.warn("Skipping ssh Go agent fixture test: 127.0.0.1:2223 is unavailable");
      return;
    }
    if (!fs.existsSync(`${LOCAL_AGENT_DIST_DIR}/manifest.json`)) {
      console.warn(
        `Skipping ssh Go agent fixture test: ${LOCAL_AGENT_DIST_DIR}/manifest.json is unavailable`,
      );
      return;
    }

    const bootstrap = await ensureRemoteAgent(
      {
        host: FIXTURE_HOST,
        user: FIXTURE_USER,
        port: FIXTURE_PORT,
        remotePath: FIXTURE_REMOTE_PATH,
        authMode: "interactive",
      },
      {
        promptHandler: answerFixturePrompt,
        auth: { spawnPty: spawnNodeBackedPty, authTimeoutMs: 10_000 },
      },
    );
    const channel = createSshChannel(
      {
        host: FIXTURE_HOST,
        user: FIXTURE_USER,
        port: FIXTURE_PORT,
        authMode: "interactive",
        remoteCommand: bootstrap.remoteCommand,
        controlPath: bootstrap.controlPath,
      },
      { promptHandler: answerFixturePrompt, requestTimeoutMs: 5_000 },
    );
    const provider = new SshFsProvider(
      {
        kind: "ssh",
        host: FIXTURE_HOST,
        user: FIXTURE_USER,
        port: FIXTURE_PORT,
        remotePath: FIXTURE_REMOTE_PATH,
        authMode: "interactive",
      },
      channel,
    );

    try {
      await expect(channel.ready).resolves.toBeUndefined();
      await expect(provider.readdir(".")).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "src" })]),
      );
      await expect(provider.readFile("src/hello.ts")).resolves.toMatchObject({
        content: expect.stringContaining("hello"),
      });
    } finally {
      channel.dispose();
      bootstrap.dispose?.();
    }
  }, 30_000);
});

async function answerFixturePrompt(prompt: { kind: "password" | "host-key"; promptId: string }) {
  if (prompt.kind === "host-key")
    return { kind: "host-key" as const, promptId: prompt.promptId, trust: "yes" as const };
  return { kind: "password" as const, promptId: prompt.promptId, value: FIXTURE_PASSWORD };
}

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
