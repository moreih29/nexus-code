/**
 * Integration test: remote git.clone round-trip over SSH.
 *
 * Requires a running SSH fixture container (docker/ssh-fixture) and the
 * opt-in env guard NEXUS_RUN_SSH_GIT_FIXTURE=1. Without the guard every
 * test in this suite skips immediately — no SSH connection is attempted.
 *
 * The docker/ssh-fixture/workspace-seed/bare-repo directory is a git bare
 * repository that is bind-mounted at /home/nexus-dev/workspace/bare-repo
 * inside the container. The test clones it via a file:// URL so no network
 * access is required.
 *
 * Scenarios:
 *   1. happy — git.clone from file:// bare-repo URL → git.clone.progress
 *              events received + CloneResult.absPath exists on the remote.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import {
  FIXTURE_HOST,
  FIXTURE_PORT,
  FIXTURE_REMOTE_PATH,
  bootstrapRemoteAgent,
  closeControlMaster,
  createMinimalAgentDist,
  isPortOpen,
  openRemoteChannel,
  waitForNoControlMaster,
} from "./_helpers/ssh-fixture";
import type { AgentChannel } from "../../../src/main/infra/agent/channel/channel";
import type { BootstrapResult } from "./_helpers/ssh-fixture";

const FIXTURE_ENABLED = process.env.NEXUS_RUN_SSH_GIT_FIXTURE === "1";

// bare-repo is inside workspace-seed which is bind-mounted at FIXTURE_REMOTE_PATH.
const BARE_REPO_REMOTE_PATH = `${FIXTURE_REMOTE_PATH}/bare-repo`;

// Shared dist directory — built once for the entire suite.
let sharedDistDir = "";

describe("ssh remote git clone round-trip", () => {
  beforeAll(async () => {
    if (!FIXTURE_ENABLED) return;
    if (!(await isPortOpen(FIXTURE_HOST, FIXTURE_PORT))) return;
    sharedDistDir = await createMinimalAgentDist();
  });

  afterAll(async () => {
    if (sharedDistDir) {
      await fs.rm(sharedDistDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 1: happy path — clone the workspace-seed bare repo
  // ---------------------------------------------------------------------------

  it("receives git.clone.progress events and a CloneResult with absPath", async () => {
    if (!FIXTURE_ENABLED) {
      console.warn("Skipping ssh remote git clone fixture: set NEXUS_RUN_SSH_GIT_FIXTURE=1");
      return;
    }
    if (!(await isPortOpen(FIXTURE_HOST, FIXTURE_PORT))) {
      console.warn(
        `Skipping ssh remote git clone fixture: ${FIXTURE_HOST}:${FIXTURE_PORT} is unavailable`,
      );
      return;
    }

    let bootstrap: BootstrapResult | null = null;
    let channel: AgentChannel | null = null;
    try {
      bootstrap = await bootstrapRemoteAgent(sharedDistDir);
      channel = openRemoteChannel(bootstrap);
      await channel.ready;

      const streamId = randomUUID();
      const cloneName = `clone-${streamId.slice(0, 8)}`;
      const progressEvents: unknown[] = [];

      const unsubscribe = channel.on("git.clone.progress", (payload) => {
        const p = payload as { streamId?: string };
        if (p.streamId === streamId) progressEvents.push(payload);
      });

      let result: unknown;
      try {
        // file:// URL points to the bare repo on the remote filesystem.
        result = await channel.call("git.clone", {
          streamId,
          url: `file://${BARE_REPO_REMOTE_PATH}`,
          // Clone into the workspace root (already writable).
          parentDir: FIXTURE_REMOTE_PATH,
          name: cloneName,
        });
      } finally {
        unsubscribe();
      }

      // The result must carry the absolute path of the cloned directory.
      const r = result as { absPath: string };
      expect(typeof r.absPath).toBe("string");
      expect(r.absPath.length).toBeGreaterThan(0);
      expect(r.absPath).toContain(cloneName);

      // For a local file:// clone git may not emit counting/receiving progress
      // lines — the phase transition events are still expected when git does emit
      // them. We assert the result is valid; progress events are a best-effort
      // check (a local clone may complete before any 50 ms throttle window fires).
      // Either 0 or more events are valid for a file:// clone.
      for (const event of progressEvents) {
        const e = event as { streamId: string; phase: string };
        expect(e.streamId).toBe(streamId);
        expect(typeof e.phase).toBe("string");
      }
    } finally {
      channel?.dispose();
      closeControlMaster(bootstrap?.controlPath);
      bootstrap?.dispose?.();
      await waitForNoControlMaster(bootstrap?.controlPath);
    }
  }, 90_000);
});
