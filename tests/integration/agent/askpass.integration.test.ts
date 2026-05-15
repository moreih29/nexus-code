/**
 * Askpass integration tests exercise the ADR(b) path: Git runs an askpass
 * helper on the agent host, the agent emits a prompt event over NDJSON, and
 * Electron/main responds through git.askpass.respond. The harness uses a local
 * agent process as the SSH-host simulation because CI has no real SSH target.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalChannel } from "../../../src/main/infra/agent/local-channel";
import {
  AgentGitAskpassRequestPayloadSchema,
  AgentGitRunResultSchema,
  GIT_ASKPASS_REQUEST_EVENT,
  GIT_ASKPASS_RESPOND_METHOD,
  GIT_RUN_METHOD,
} from "../../../src/shared/protocol/git";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const goAvailable = spawnSync("go", ["version"]).status === 0;
const gitAvailable = spawnSync("git", ["--version"]).status === 0;

describe("agent askpass round-trip", () => {
  if (!goAvailable) {
    it("skips when go is unavailable", () => {});
    return;
  }

  let binPath: string;
  let buildDir: string;

  beforeAll(async () => {
    buildDir = await fs.mkdtemp(path.join(tmpdir(), "agent-askpass-build-"));
    binPath = path.join(buildDir, "agent");
    const build = spawnSync("go", ["build", "-o", binPath, "./cmd/agent"], {
      cwd: REPO_ROOT,
    });
    if (build.status !== 0) {
      throw new Error(`go build failed: ${build.stderr.toString()}`);
    }
  });

  afterAll(async () => {
    if (buildDir) {
      await fs.rm(buildDir, { recursive: true, force: true });
    }
  });

  it("supports the explicit agent --askpass <socket> helper subcommand", async () => {
    if (process.platform === "win32") return;

    const root = await fs.mkdtemp(path.join(tmpdir(), "agent-askpass-socket-"));
    const socketPath = path.join(root, "askpass.sock");
    const server = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        expect(chunk.toString("utf8")).toContain("Integration prompt");
        socket.end(`${JSON.stringify({ ok: true, value: "subcommand-secret" })}\n`);
      });
    });
    await listenUnix(server, socketPath);

    try {
      const result = await spawnAndCapture(binPath, [
        "--askpass",
        socketPath,
        "Integration prompt",
      ]);
      expect(result).toEqual({ code: 0, stdout: "subcommand-secret", stderr: "" });
    } finally {
      server.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips local/SSH-simulated Git HTTPS prompts through git.askpass.request/respond", async () => {
    if (!gitAvailable) return;

    const root = await fs.mkdtemp(path.join(tmpdir(), "agent-askpass-root-"));
    const home = await fs.mkdtemp(path.join(tmpdir(), "agent-askpass-home-"));
    const prompts: string[] = [];
    const serverState = { authorizedHeader: "" };
    const server = await startAuthGitServer(serverState);
    const channel = createLocalChannel({ binaryPath: binPath, rootPath: root });

    const unsubscribe = channel.on(GIT_ASKPASS_REQUEST_EVENT, (payload) => {
      const request = AgentGitAskpassRequestPayloadSchema.parse(payload);
      prompts.push(request.prompt);
      const secret = /username/i.test(request.prompt) ? "alice" : "s3cr3t";
      void channel.call(GIT_ASKPASS_RESPOND_METHOD, {
        requestId: request.requestId,
        secret,
      });
    });

    try {
      await channel.ready;
      const url = `http://127.0.0.1:${server.port}/repo.git`;
      const result = AgentGitRunResultSchema.parse(
        await channel.call(GIT_RUN_METHOD, {
          cwd: root,
          args: ["-c", "credential.helper=", "ls-remote", url],
          env: {
            HOME: home,
            XDG_CONFIG_HOME: home,
            GIT_CONFIG_NOSYSTEM: "1",
          },
          interactive: true,
        }),
      );

      expect(result.code).toBe(0);
      expect(prompts.some((prompt) => /username/i.test(prompt))).toBe(true);
      expect(prompts.some((prompt) => /password/i.test(prompt))).toBe(true);
      expect(serverState.authorizedHeader).toBe(
        `Basic ${Buffer.from("alice:s3cr3t").toString("base64")}`,
      );
    } finally {
      unsubscribe();
      channel.dispose();
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 20_000);
});

function listenUnix(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function spawnAndCapture(
  command: string,
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function startAuthGitServer(state: { authorizedHeader: string }): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = http.createServer((request, response) => {
    const authorization = request.headers.authorization;
    if (!authorization) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="nexus-test"' });
      response.end("auth required");
      return;
    }

    state.authorizedHeader = authorization;
    response.writeHead(200, {
      "Content-Type": "application/x-git-upload-pack-advertisement",
      "Cache-Control": "no-cache",
    });
    response.end("001e# service=git-upload-pack\n00000000");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("auth git server did not bind to TCP port");
  }

  return {
    port: address.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
