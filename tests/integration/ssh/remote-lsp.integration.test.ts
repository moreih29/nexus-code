/**
 * Integration test: remote lsp.spawn / lsp.send / lsp.shutdown round-trip over SSH.
 *
 * Requires a running SSH fixture container (docker/ssh-fixture) and the
 * opt-in env guard NEXUS_RUN_SSH_LSP_FIXTURE=1. Without the guard every
 * test in this suite skips immediately — no SSH connection is attempted.
 *
 * The fixture container has no Node runtime pre-installed. ensureRemoteLspServer
 * uploads the Node runtime tarball and the LSP archive from the local dist
 * directory (NEXUS_SSH_LSP_DIST_DIR, defaulting to dist/agent). The test
 * therefore requires a production dist that contains:
 *   - Agent binaries (linux/amd64 and linux/arm64)
 *   - Node runtime tarballs (linux/amd64 and linux/arm64)
 *   - An LSP binary archive for the binaryName supplied via env
 *     (NEXUS_SSH_LSP_BINARY_NAME, defaulting to "typescript-language-server")
 *
 * Scenarios:
 *   1. happy      — ensureRemoteAgent + ensureRemoteLspServer → lsp.spawn →
 *                   lsp.send textDocument/didOpen → lsp.message
 *                   publishDiagnostics received → lsp.shutdown.
 *   2. no-zombie  — after lsp.shutdown the LSP server process is gone from
 *                   the remote host (pgrep check via SSH).
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ensureRemoteLspServer } from "../../../src/main/infra/agent/ssh/ssh-bootstrap/index";
import { createSshChannel } from "../../../src/main/infra/agent/ssh/channel";
import { spawnNodeBackedPty } from "../main/agent/node-pty-spawn";
import {
  FIXTURE_HOST,
  FIXTURE_PORT,
  FIXTURE_REMOTE_PATH,
  FIXTURE_USER,
  answerFixturePrompt,
  bootstrapRemoteAgent,
  closeControlMaster,
  isPortOpen,
  sleep,
  waitForNoControlMaster,
} from "./_helpers/ssh-fixture";
import type { AgentChannel } from "../../../src/main/infra/agent/channel";
import type { BootstrapResult } from "./_helpers/ssh-fixture";

const FIXTURE_ENABLED = process.env.NEXUS_RUN_SSH_LSP_FIXTURE === "1";

// Production dist directory with Node runtime + LSP archive included.
// This defaults to the standard output location of the build pipeline.
const LSP_DIST_DIR =
  process.env.NEXUS_SSH_LSP_DIST_DIR ??
  path.join(process.env.REPO_ROOT ?? path.resolve(__dirname, "..", "..", ".."), "dist", "agent");

// LSP binary name as registered in the dist manifest.
const LSP_BINARY_NAME =
  process.env.NEXUS_SSH_LSP_BINARY_NAME ?? "typescript-language-server";

// Workspace-seed TypeScript file that the LSP server will analyse.
const REMOTE_TS_FILE = path.posix.join(FIXTURE_REMOTE_PATH, "src", "hello.ts");

// Shared bootstrap state — rebuilt for each test to avoid cross-contamination.
let sharedDistDir = "";

describe("ssh remote lsp round-trip", () => {
  beforeAll(async () => {
    if (!FIXTURE_ENABLED) return;
    if (!(await isPortOpen(FIXTURE_HOST, FIXTURE_PORT))) return;
    // Use the production dist dir (which must contain Node + LSP tarballs).
    sharedDistDir = LSP_DIST_DIR;
  });

  afterAll(async () => {
    // LSP_DIST_DIR is the production dist — do NOT delete it.
  });

  // ---------------------------------------------------------------------------
  // Scenario 1: happy path
  //   ensureRemoteLspServer → lsp.spawn → didOpen → publishDiagnostics → shutdown
  // ---------------------------------------------------------------------------

  it("spawns LSP server remotely, sends didOpen, receives publishDiagnostics, and shuts down", async () => {
    if (!FIXTURE_ENABLED) {
      console.warn("Skipping ssh remote LSP fixture: set NEXUS_RUN_SSH_LSP_FIXTURE=1");
      return;
    }
    if (!(await isPortOpen(FIXTURE_HOST, FIXTURE_PORT))) {
      console.warn(
        `Skipping ssh remote LSP fixture: ${FIXTURE_HOST}:${FIXTURE_PORT} is unavailable`,
      );
      return;
    }

    let agentBootstrap: BootstrapResult | null = null;
    let channel: AgentChannel | null = null;
    try {
      // Bootstrap the remote agent first (this uploads the Go binary).
      agentBootstrap = await bootstrapRemoteAgent(sharedDistDir);

      // Bootstrap the LSP server (uploads Node runtime + LSP archive).
      const lspBootstrap = await ensureRemoteLspServer(
        {
          host: FIXTURE_HOST,
          user: FIXTURE_USER,
          port: FIXTURE_PORT,
          remotePath: FIXTURE_REMOTE_PATH,
          authMode: "interactive",
          controlPath: agentBootstrap.controlPath,
          binaryName: LSP_BINARY_NAME,
          languageId: "typescript",
        },
        {
          distDir: sharedDistDir,
          promptHandler: answerFixturePrompt,
          auth: { spawnPty: spawnNodeBackedPty, authTimeoutMs: 10_000 },
        },
      );

      // Open the data channel reusing the existing ControlMaster.
      channel = createSshChannel(
        {
          host: FIXTURE_HOST,
          user: FIXTURE_USER,
          port: FIXTURE_PORT,
          authMode: "interactive",
          remoteCommand: agentBootstrap.remoteCommand,
          controlPath: agentBootstrap.controlPath,
        },
        { promptHandler: answerFixturePrompt, requestTimeoutMs: 30_000 },
      );
      await channel.ready;

      const workspaceId = randomUUID();
      const messagePayloads: unknown[] = [];

      const unsubscribeMsg = channel.on("lsp.message", (payload) => {
        messagePayloads.push(payload);
      });

      let spawnResult: { serverId: string; capabilities: unknown } | null = null;
      try {
        // lsp.spawn runs initialize internally and resolves with serverId.
        spawnResult = await channel.call<{ serverId: string; capabilities: unknown }>("lsp.spawn", {
          workspaceId,
          languageId: "typescript",
          binaryPath: lspBootstrap.binaryPath,
          args: [...lspBootstrap.args],
          workspaceRoot: FIXTURE_REMOTE_PATH,
          // Disable idle timeout for tests.
          idleTimeoutMs: 0,
        });
      } finally {
        unsubscribeMsg();
      }

      expect(typeof spawnResult?.serverId).toBe("string");
      expect((spawnResult?.serverId ?? "").length).toBeGreaterThan(0);

      // Subscribe to lsp.message events before sending didOpen.
      const diagPromise = waitForDiagnosticsMessage(channel, spawnResult.serverId, 15_000);

      // hello.ts contains `export function hello(name: string): string` —
      // sending it as TypeScript is valid and should produce at least an empty
      // publishDiagnostics notification once the server indexes the file.
      const fileUri = pathToFileURL(REMOTE_TS_FILE).toString();
      await channel.call("lsp.send", {
        serverId: spawnResult.serverId,
        message: {
          jsonrpc: "2.0",
          method: "textDocument/didOpen",
          params: {
            textDocument: {
              uri: fileUri,
              languageId: "typescript",
              version: 1,
              text: 'export function hello(name: string): string {\n  return `hello, ${name}`;\n}\n',
            },
          },
        },
      });

      const diagMessage = await diagPromise;
      const inner = diagMessage as { method?: string };
      expect(inner.method).toBe("textDocument/publishDiagnostics");

      // Clean shutdown.
      await channel.call("lsp.shutdown", { serverId: spawnResult.serverId }).catch(() => {
        // Shutdown is best-effort — accept if already exited.
      });
    } finally {
      channel?.dispose();
      closeControlMaster(agentBootstrap?.controlPath);
      agentBootstrap?.dispose?.();
      await waitForNoControlMaster(agentBootstrap?.controlPath);
    }
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Scenario 2: no zombie — after shutdown the LSP process is gone on the remote
  // ---------------------------------------------------------------------------

  it("leaves no LSP server processes on the remote host after lsp.shutdown", async () => {
    if (!FIXTURE_ENABLED) {
      console.warn("Skipping ssh remote LSP fixture: set NEXUS_RUN_SSH_LSP_FIXTURE=1");
      return;
    }
    if (!(await isPortOpen(FIXTURE_HOST, FIXTURE_PORT))) {
      console.warn(
        `Skipping ssh remote LSP fixture: ${FIXTURE_HOST}:${FIXTURE_PORT} is unavailable`,
      );
      return;
    }

    let agentBootstrap: BootstrapResult | null = null;
    let channel: AgentChannel | null = null;
    try {
      agentBootstrap = await bootstrapRemoteAgent(sharedDistDir);

      const lspBootstrap = await ensureRemoteLspServer(
        {
          host: FIXTURE_HOST,
          user: FIXTURE_USER,
          port: FIXTURE_PORT,
          remotePath: FIXTURE_REMOTE_PATH,
          authMode: "interactive",
          controlPath: agentBootstrap.controlPath,
          binaryName: LSP_BINARY_NAME,
          languageId: "typescript",
        },
        {
          distDir: sharedDistDir,
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
          remoteCommand: agentBootstrap.remoteCommand,
          controlPath: agentBootstrap.controlPath,
        },
        { promptHandler: answerFixturePrompt, requestTimeoutMs: 30_000 },
      );
      await channel.ready;

      const workspaceId = randomUUID();
      const spawnResult = await channel.call<{ serverId: string }>("lsp.spawn", {
        workspaceId,
        languageId: "typescript",
        binaryPath: lspBootstrap.binaryPath,
        args: [...lspBootstrap.args],
        workspaceRoot: FIXTURE_REMOTE_PATH,
        idleTimeoutMs: 0,
      });

      // Allow the server to finish starting up.
      await sleep(300);

      // Shut down cleanly and dispose the channel so the Go agent exits.
      await channel.call("lsp.shutdown", { serverId: spawnResult.serverId }).catch(() => {});
      channel.dispose();
      channel = null;

      // Give the remote OS a moment to reap the child process.
      await sleep(500);

      // Verify via remote pgrep that no LSP server process remains.
      // pgrep exits 1 when there are no matches — that is the expected outcome.
      const pgrepResult = spawnSync("ssh", [
        "-o",
        "BatchMode=yes",
        "-o",
        `ControlPath=${agentBootstrap.controlPath}`,
        "-o",
        "ControlMaster=no",
        "-p",
        String(FIXTURE_PORT),
        "--",
        `${FIXTURE_USER}@${FIXTURE_HOST}`,
        `pgrep -f ${LSP_BINARY_NAME} || true`,
      ]);
      const output = (pgrepResult.stdout ?? Buffer.alloc(0)).toString("utf8").trim();
      // An empty output means pgrep found nothing — the LSP server is gone.
      // A non-empty output means processes exist, which is a test failure.
      expect(output).toBe("");
    } finally {
      channel?.dispose();
      closeControlMaster(agentBootstrap?.controlPath);
      agentBootstrap?.dispose?.();
      await waitForNoControlMaster(agentBootstrap?.controlPath);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LspMessagePayload {
  serverId: string;
  message: unknown;
}

/**
 * Resolves with the first lsp.message notification whose inner message has
 * method "textDocument/publishDiagnostics" for the given serverId.
 */
function waitForDiagnosticsMessage(
  channel: AgentChannel,
  serverId: string,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for publishDiagnostics from server ${serverId}`));
    }, timeoutMs);

    const unsubscribe = channel.on("lsp.message", (raw) => {
      const payload = raw as LspMessagePayload;
      if (payload.serverId !== serverId) return;
      let inner: unknown;
      try {
        inner =
          typeof payload.message === "string"
            ? (JSON.parse(payload.message) as unknown)
            : payload.message;
      } catch {
        return;
      }
      const msg = inner as { method?: string };
      if (msg.method !== "textDocument/publishDiagnostics") return;
      clearTimeout(timer);
      unsubscribe();
      resolve(inner);
    });
  });
}
