/**
 * Integration test for Fix 1: session-scoped SSH credential reuse on reconnect.
 *
 * Reproduces the real "SSH 재연결 시 터미널 끊김" scenario end-to-end against the
 * dockerised password sshd fixture:
 *
 *   1. Authenticate a ControlMaster interactively (password prompt fires once).
 *   2. Kill the ControlMaster — this is what a laptop sleep / long network drop
 *      does to the persistent master that holds the authenticated session.
 *   3. Re-authenticate (the manager's scheduleReauth path) with the SAME
 *      credential-caching prompt handler.
 *
 * With Fix 1 the second auth reuses the cached password and succeeds against the
 * real sshd WITHOUT invoking the renderer prompt again — so the password prompt
 * handler is called exactly once across both auths. Before the fix the reauth
 * re-prompts (handler called twice), which in production times out unattended
 * (30s) and drops the workspace into a permanent error state.
 *
 * Opt-in only. Run with the fixture up:
 *   docker compose -f tests/integration/ssh/_fixture/docker-compose.yml up -d --build
 *   NEXUS_RUN_SSH_RECONNECT_FIXTURE=1 NEXUS_SSH_FIXTURE_PORT=2224 \
 *     bun test tests/integration/ssh/ssh-reconnect-reauth.integration.test.ts
 */
import { describe, expect, it } from "bun:test";
import net from "node:net";
import { authenticateSshControlMaster } from "../../../src/main/infra/agent/ssh/auth-pty";
import { createCachingAuthPromptHandler } from "../../../src/main/infra/agent/ssh/credential-cache";
import type { SshAuthPrompt, SshAuthResponse } from "../../../src/shared/ssh/auth-prompt";
import { spawnNodeBackedPty } from "./_helpers/node-pty-spawn";

const FIXTURE_HOST = process.env.NEXUS_SSH_FIXTURE_HOST ?? "127.0.0.1";
const FIXTURE_PORT = Number(process.env.NEXUS_SSH_FIXTURE_PORT ?? "2224");
const FIXTURE_USER = process.env.NEXUS_SSH_FIXTURE_USER ?? "nexus-dev";
const FIXTURE_PASSWORD = process.env.NEXUS_SSH_FIXTURE_PASSWORD ?? "nexus-dev";
const FIXTURE_ENABLED = process.env.NEXUS_RUN_SSH_RECONNECT_FIXTURE === "1";

describe("ssh reconnect credential reuse (linux-password fixture)", () => {
  it.skipIf(!FIXTURE_ENABLED)(
    "reuses the cached password on reauth after ControlMaster death — no re-prompt",
    async () => {
      if (!(await isPortOpen(FIXTURE_HOST, FIXTURE_PORT))) {
        console.warn(
          `Skipping ssh reconnect reauth fixture test: ${FIXTURE_HOST}:${FIXTURE_PORT} is unavailable`,
        );
        return;
      }

      // Counting inner handler: every renderer-facing prompt increments here.
      // The caching wrapper (Fix 1) must shield it on reauth.
      let passwordPrompts = 0;
      let hostKeyPrompts = 0;
      const inner = async (prompt: SshAuthPrompt): Promise<SshAuthResponse> => {
        if (prompt.kind === "host-key") {
          hostKeyPrompts += 1;
          return { kind: "host-key", promptId: prompt.promptId, trust: "yes" };
        }
        passwordPrompts += 1;
        return { kind: "password", promptId: prompt.promptId, value: FIXTURE_PASSWORD };
      };
      const handler = createCachingAuthPromptHandler(inner);

      const options = { host: FIXTURE_HOST, user: FIXTURE_USER, port: FIXTURE_PORT };
      const authDeps = { spawnPty: spawnNodeBackedPty, authTimeoutMs: 10_000 };

      // ── 1. Initial interactive auth — password prompt fires exactly once. ──
      const master1 = await authenticateSshControlMaster(options, handler, authDeps);
      expect(passwordPrompts).toBe(1);

      // ── 2. Kill the ControlMaster (laptop sleep / long network drop). ──
      master1.dispose();

      // ── 3. Reauth (manager scheduleReauth path) over a fresh master. ──
      // Must succeed against the REAL sshd using the cached credential, and
      // must NOT invoke the renderer prompt again.
      const master2 = await authenticateSshControlMaster(options, handler, authDeps);
      try {
        // GREEN (Fix 1): cached password reused → still 1.
        // RED (pre-fix): reauth re-prompts → 2.
        expect(passwordPrompts).toBe(1);
        expect(hostKeyPrompts).toBeLessThanOrEqual(1);
      } finally {
        master2.dispose();
      }
    },
    60_000,
  );
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
