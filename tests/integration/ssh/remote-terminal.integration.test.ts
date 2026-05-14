import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { startAgentPtyHost } from "../../../src/main/features/pty/agent-host";
import type { PtyHostHandle } from "../../../src/main/features/pty/host";
import type { AgentChannel } from "../../../src/main/infra/agent/channel";
import { createSshChannel } from "../../../src/main/infra/agent/ssh-channel";
import { ensureRemoteAgent } from "../../../src/main/infra/agent/ssh-bootstrap";
import { AgentManifestSchema } from "../../../src/shared/agent-manifest";
import { spawnNodeBackedPty } from "../main/agent/node-pty-spawn";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const MEMORY_PATH = path.join(REPO_ROOT, ".nexus", "memory", "empirical-ssh-remote-terminal.md");
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const TAB_ID = "33333333-3333-4333-8333-333333333333";

const FIXTURE_HOST = process.env.NEXUS_SSH_FIXTURE_HOST ?? "127.0.0.1";
const FIXTURE_PORT = Number(process.env.NEXUS_SSH_FIXTURE_PORT ?? "2223");
const FIXTURE_USER = process.env.NEXUS_SSH_FIXTURE_USER ?? "nexus-dev";
const FIXTURE_PASSWORD = process.env.NEXUS_SSH_FIXTURE_PASSWORD ?? "nexus-dev";
const FIXTURE_REMOTE_PATH =
  process.env.NEXUS_SSH_FIXTURE_REMOTE_PATH ?? "/home/nexus-dev/workspace";

describe("ssh remote terminal round-trip", () => {
  it("opens a remote agent PTY, verifies pwd/uname, and exits cleanly", async () => {
    if (process.env.NEXUS_RUN_SSH_PTY_FIXTURE !== "1") {
      console.warn("Skipping ssh remote terminal fixture: set NEXUS_RUN_SSH_PTY_FIXTURE=1");
      return;
    }
    if (!(await isPortOpen(FIXTURE_HOST, FIXTURE_PORT))) {
      console.warn(
        `Skipping ssh remote terminal fixture: ${FIXTURE_HOST}:${FIXTURE_PORT} is unavailable`,
      );
      return;
    }

    const distDir = await createMinimalAgentDist();
    let bootstrap: Awaited<ReturnType<typeof ensureRemoteAgent>> | null = null;
    let channel: AgentChannel | null = null;
    let terminal: RemoteTerminalFixture | null = null;
    try {
      bootstrap = await ensureRemoteAgent(
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
      channel = createSshChannel(
        {
          host: FIXTURE_HOST,
          user: FIXTURE_USER,
          port: FIXTURE_PORT,
          authMode: "interactive",
          remoteCommand: bootstrap.remoteCommand,
          controlPath: bootstrap.controlPath,
        },
        { promptHandler: answerFixturePrompt, requestTimeoutMs: 10_000 },
      );
      terminal = new RemoteTerminalFixture(channel);
      await channel.ready;
      await terminal.spawn("/bin/sh");
      await terminal.write("stty -echo\n");
      await sleep(150);
      await terminal.write("printf '__PWD__'; pwd\nprintf '__UNAME__'; uname -a\nexit 0\n");

      await terminal.waitForTranscript("__PWD__");
      await terminal.waitForTranscript("__UNAME__");
      const exit = await terminal.waitForExit();
      const transcript = terminal.transcript();
      const pwd = extractMarkedLine(transcript, "__PWD__", (value) => value.startsWith("/"));
      const uname = extractMarkedLine(
        transcript,
        "__UNAME__",
        (value) => !value.includes("printf") && value.trim().length > 0,
      );

      expect(pwd).toBe(FIXTURE_REMOTE_PATH);
      expect(uname).toContain("Linux");
      expect(uname).not.toContain("Darwin");
      expect(exit.code).toBe(0);

      await writeEmpiricalMemory({
        remoteOS: uname,
        pwd,
        transcript,
        uploaded: bootstrap.uploaded,
      });
    } finally {
      terminal?.dispose();
      channel?.dispose();
      closeControlMaster(bootstrap?.controlPath);
      bootstrap?.dispose?.();
      await waitForNoControlMaster(bootstrap?.controlPath);
      await fs.rm(distDir, { recursive: true, force: true });
    }
  }, 60_000);
});

interface PtyExitEvent {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly code: number | null;
}

/**
 * RemoteTerminalFixture captures main-host PTY events while driving one SSH
 * agent channel through the production AgentPtyHost.
 */
class RemoteTerminalFixture {
  private readonly host: PtyHostHandle;
  private readonly chunks: string[] = [];
  private readonly exits: PtyExitEvent[] = [];

  constructor(channel: AgentChannel) {
    this.host = startAgentPtyHost({ getAgentChannel: async () => channel });
    this.host.on("data", (payload) => {
      const event = payload as { workspaceId: string; tabId: string; chunk: string };
      if (event.workspaceId === WORKSPACE_ID && event.tabId === TAB_ID) {
        this.chunks.push(event.chunk);
      }
    });
    this.host.on("exit", (payload) => {
      const event = payload as PtyExitEvent;
      if (event.workspaceId === WORKSPACE_ID && event.tabId === TAB_ID) {
        this.exits.push(event);
      }
    });
  }

  /**
   * Spawns the remote shell under the remote workspace path.
   */
  async spawn(shell: string): Promise<void> {
    const result = (await this.host.call("spawn", {
      workspaceId: WORKSPACE_ID,
      tabId: TAB_ID,
      cwd: FIXTURE_REMOTE_PATH,
      shell,
      cols: 80,
      rows: 24,
      env: { TERM: "xterm-256color" },
    })) as { pid?: unknown };
    expect(typeof result.pid).toBe("number");
  }

  /**
   * Writes input bytes into the remote shell PTY.
   */
  async write(data: string): Promise<void> {
    await this.host.call("write", { workspaceId: WORKSPACE_ID, tabId: TAB_ID, data });
  }

  /**
   * Returns captured remote terminal output.
   */
  transcript(): string {
    return this.chunks.join("");
  }

  /**
   * Waits until remote terminal output contains marker.
   */
  waitForTranscript(marker: string, timeoutMs = 10_000): Promise<void> {
    return waitUntil(
      () => this.transcript().includes(marker),
      () => `timed out waiting for ${marker}; transcript:\n${this.transcript()}`,
      timeoutMs,
    );
  }

  /**
   * Waits for the remote shell exit event.
   */
  async waitForExit(timeoutMs = 10_000): Promise<PtyExitEvent> {
    await waitUntil(
      () => this.exits.length > 0,
      () => `timed out waiting for remote pty.exit; transcript:\n${this.transcript()}`,
      timeoutMs,
    );
    return this.exits[0];
  }

  /**
   * Disposes the main-host wrapper without owning the SSH channel.
   */
  dispose(): void {
    this.host.dispose();
  }
}

/**
 * Answers the local Docker-style fixture's password and host-key prompts.
 */
async function answerFixturePrompt(prompt: { kind: "password" | "host-key"; promptId: string }) {
  if (prompt.kind === "host-key") {
    return { kind: "host-key" as const, promptId: prompt.promptId, trust: "yes" as const };
  }
  return { kind: "password" as const, promptId: prompt.promptId, value: FIXTURE_PASSWORD };
}

/**
 * Builds a small SSH-agent distribution containing only Linux Go agent
 * binaries. ensureRemoteAgent only needs the agent artifact for this test.
 */
async function createMinimalAgentDist(): Promise<string> {
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

  const nodePlaceholder = Buffer.from("remote-terminal-test-placeholder\n", "utf8");
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

/**
 * Extracts one marker-prefixed line from noisy PTY output.
 */
function extractMarkedLine(
  transcript: string,
  marker: string,
  predicate: (value: string) => boolean,
): string {
  const candidates = transcript
    .split(/\r?\n/)
    .map((line) => {
      const index = line.indexOf(marker);
      return index >= 0 ? line.slice(index + marker.length).trim() : "";
    })
    .filter((value) => value.length > 0 && predicate(value));
  const value = candidates.at(-1);
  if (!value) {
    throw new Error(`missing ${marker} output in transcript:\n${transcript}`);
  }
  return value;
}

/**
 * Synchronously asks the fixture ControlMaster to exit before its socket path
 * is removed by the production disposer.
 */
function closeControlMaster(controlPath: string | undefined): void {
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
 * Verifies the opt-in fixture did not leave a local ControlMaster process.
 */
async function waitForNoControlMaster(
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

/**
 * Returns the current local process command list for cleanup assertions.
 */
function localProcessList(): string {
  return spawnSync("ps", ["-axo", "command"], { encoding: "utf8" }).stdout;
}

/**
 * Records the user-value SSH terminal evidence for the planning memory layer.
 */
async function writeEmpiricalMemory(args: {
  readonly remoteOS: string;
  readonly pwd: string;
  readonly transcript: string;
  readonly uploaded: boolean;
}): Promise<void> {
  const excerpt = args.transcript
    .split(/\r?\n/)
    .filter((line) => line.includes("__PWD__") || line.includes("__UNAME__"))
    .map((line) => line.replaceAll(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""))
    .slice(-4)
    .join("\n");
  const content = `# empirical: SSH remote terminal round-trip

Date: 2026-05-14

## Fixture

- Host: ${FIXTURE_USER}@${FIXTURE_HOST}:${FIXTURE_PORT}
- Remote workspace path: ${FIXTURE_REMOTE_PATH}
- Agent uploaded during run: ${args.uploaded ? "yes" : "no, existing artifact reused"}

## Result

- Remote OS: \`${args.remoteOS}\`
- \`pwd\` inside the PTY matched the remote workspace path: \`${args.pwd}\`
- \`exit 0\` produced PTY exit code \`0\`
- The \`uname -a\` output contains Linux and does not contain local Darwin, so the terminal was remote.

## Output excerpt

\`\`\`
${excerpt}
\`\`\`

## Limitation

This validates the opt-in SSH password fixture path, not every user SSH auth mode or host OS.
`;
  await fs.writeFile(MEMORY_PATH, content, "utf8");
}

/**
 * Checks whether the opt-in SSH fixture port is accepting TCP connections.
 */
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

/**
 * Hashes a buffer for the temporary agent manifest.
 */
function sha256(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Polls a condition until it passes or raises the caller's diagnostic message.
 */
async function waitUntil(
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
 * Promise wrapper around setTimeout for bounded async waits.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
