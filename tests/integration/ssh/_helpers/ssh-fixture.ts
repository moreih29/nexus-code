/**
 * Shared helpers for SSH remote integration tests.
 *
 * All tests in this directory are opt-in via domain-specific env guards.
 * Without the guard the test body returns early and the suite reports only
 * the skip message — no SSH connection is attempted.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureRemoteAgent } from "../../../../src/main/infra/agent/ssh/ssh-bootstrap/index";
import { createSshChannel } from "../../../../src/main/infra/agent/ssh/channel";
import { AgentManifestSchema } from "../../../../src/shared/agent/manifest";
import { spawnNodeBackedPty } from "../../main/agent/node-pty-spawn";
import type { AgentChannel } from "../../../../src/main/infra/agent/channel";

export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

export const FIXTURE_HOST = process.env.NEXUS_SSH_FIXTURE_HOST ?? "127.0.0.1";
export const FIXTURE_PORT = Number(process.env.NEXUS_SSH_FIXTURE_PORT ?? "2223");
export const FIXTURE_USER = process.env.NEXUS_SSH_FIXTURE_USER ?? "nexus-dev";
export const FIXTURE_PASSWORD = process.env.NEXUS_SSH_FIXTURE_PASSWORD ?? "nexus-dev";
export const FIXTURE_REMOTE_PATH =
  process.env.NEXUS_SSH_FIXTURE_REMOTE_PATH ?? "/home/nexus-dev/workspace";

// ---------------------------------------------------------------------------
// Bootstrap helpers
// ---------------------------------------------------------------------------

export type BootstrapResult = Awaited<ReturnType<typeof ensureRemoteAgent>>;

/**
 * Wraps ensureRemoteAgent with the fixture-default options.
 */
export async function bootstrapRemoteAgent(distDir: string): Promise<BootstrapResult> {
  return ensureRemoteAgent(
    {
      host: FIXTURE_HOST,
      user: FIXTURE_USER,
      port: FIXTURE_PORT,
      remotePath: FIXTURE_REMOTE_PATH,
      authMode: "interactive",
    },
    {
      distDir,
      promptHandler: answerFixturePrompt,
      auth: { spawnPty: spawnNodeBackedPty, authTimeoutMs: 10_000 },
    },
  );
}

/**
 * Creates an SSH channel reusing the ControlMaster opened by bootstrap.
 */
export function openRemoteChannel(bootstrap: BootstrapResult): AgentChannel {
  return createSshChannel(
    {
      host: FIXTURE_HOST,
      user: FIXTURE_USER,
      port: FIXTURE_PORT,
      authMode: "interactive",
      remoteCommand: bootstrap.remoteCommand,
      controlPath: bootstrap.controlPath,
    },
    { promptHandler: answerFixturePrompt, requestTimeoutMs: 30_000 },
  );
}

// ---------------------------------------------------------------------------
// Dist builders
// ---------------------------------------------------------------------------

/**
 * Builds a minimal agent dist (agent binary only, node placeholder, no LSP
 * binaries). Sufficient for search and git-clone scenarios where the remote
 * agent does not need a Node runtime.
 */
export async function createMinimalAgentDist(): Promise<string> {
  const outDir = await fs.mkdtemp(path.join(tmpdir(), "nexus-ssh-agent-dist-"));
  const targets = [
    { os: "linux", arch: "amd64" },
    { os: "linux", arch: "arm64" },
  ] as const;
  const binaries = [];

  for (const target of targets) {
    const filename = `agent-0.1.0-${target.os}-${target.arch}`;
    const artifactPath = path.join(outDir, filename);
    const build = spawnSync("go", ["build", "-ldflags=-s -w", "-o", artifactPath, "./cmd/agent"], {
      cwd: REPO_ROOT,
      env: { ...process.env, GOOS: target.os, GOARCH: target.arch },
    });
    if (build.status !== 0) {
      throw new Error(`go build ${target.os}/${target.arch} failed: ${build.stderr.toString()}`);
    }
    const payload = await fs.readFile(artifactPath);
    binaries.push({
      ...target,
      path: filename,
      sha256: sha256(payload),
      size: payload.byteLength,
    });
  }

  const nodePlaceholder = Buffer.from("remote-ssh-test-node-placeholder\n", "utf8");
  await fs.writeFile(path.join(outDir, "node-placeholder"), nodePlaceholder);

  const manifest = AgentManifestSchema.parse({
    version: "0.1.0",
    protocolVersion: "1",
    binaries,
    runtime: {
      node: targets.map((target) => ({
        ...target,
        version: "test-placeholder",
        path: "node-placeholder",
        sha256: sha256(nodePlaceholder),
        size: nodePlaceholder.byteLength,
        entry: "bin/node",
      })),
    },
    lspBinaries: [],
  });
  await fs.writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return outDir;
}

// ---------------------------------------------------------------------------
// Prompt handler
// ---------------------------------------------------------------------------

/**
 * Answers the Docker fixture's password and host-key prompts automatically.
 */
export async function answerFixturePrompt(prompt: {
  kind: "password" | "host-key";
  promptId: string;
}) {
  if (prompt.kind === "host-key") {
    return { kind: "host-key" as const, promptId: prompt.promptId, trust: "yes" as const };
  }
  return { kind: "password" as const, promptId: prompt.promptId, value: FIXTURE_PASSWORD };
}

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

/**
 * Asks the fixture ControlMaster to exit before the production disposer removes
 * its socket path.
 */
export function closeControlMaster(controlPath: string | undefined): void {
  if (!controlPath) return;
  spawnSync(
    "ssh",
    [
      "-S",
      controlPath,
      "-O",
      "exit",
      "-p",
      String(FIXTURE_PORT),
      "--",
      `${FIXTURE_USER}@${FIXTURE_HOST}`,
    ],
    { stdio: "ignore" },
  );
}

/**
 * Polls until the local SSH ControlMaster process for controlPath is gone.
 */
export async function waitForNoControlMaster(
  controlPath: string | undefined,
  timeoutMs = 2_000,
): Promise<void> {
  if (!controlPath) return;
  await waitUntil(
    () => !localProcessList().includes(controlPath),
    () => `local SSH ControlMaster still running for ${controlPath}`,
    timeoutMs,
  );
}

function localProcessList(): string {
  return spawnSync("ps", ["-axo", "command"], { encoding: "utf8" }).stdout;
}

// ---------------------------------------------------------------------------
// Port availability check
// ---------------------------------------------------------------------------

/**
 * Returns true when the SSH fixture port is accepting TCP connections.
 */
export function isPortOpen(host: string, port: number): Promise<boolean> {
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

// ---------------------------------------------------------------------------
// Polling utilities
// ---------------------------------------------------------------------------

/**
 * Polls predicate at 20 ms intervals until it returns true or timeoutMs elapses.
 */
export async function waitUntil(
  predicate: () => boolean,
  message: () => string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(message());
}

/**
 * Promise wrapper around setTimeout.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Cryptographic helpers
// ---------------------------------------------------------------------------

export function sha256(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}
