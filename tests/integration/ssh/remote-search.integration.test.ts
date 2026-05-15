/**
 * Integration test: remote search.text / search.cancel round-trip over SSH.
 *
 * Requires a running SSH fixture container (docker/ssh-fixture) and the
 * opt-in env guard NEXUS_RUN_SSH_SEARCH_FIXTURE=1. Without the guard every
 * test in this suite skips immediately — no SSH connection is attempted.
 *
 * Scenarios:
 *   1. happy  — search.text on workspace-seed files → search.progress events
 *               with matches + complete with matchesFound > 0.
 *   2. cancel — search.cancel lands before walk finishes → cancelled error or
 *               valid complete (both are valid protocol outcomes).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  FIXTURE_HOST,
  FIXTURE_PORT,
  bootstrapRemoteAgent,
  closeControlMaster,
  createMinimalAgentDist,
  isPortOpen,
  openRemoteChannel,
  sleep,
  waitForNoControlMaster,
} from "./_helpers/ssh-fixture";
import type { AgentChannel } from "../../../src/main/infra/agent/channel/channel";
import type { BootstrapResult } from "./_helpers/ssh-fixture";
import fs from "node:fs/promises";

const FIXTURE_ENABLED = process.env.NEXUS_RUN_SSH_SEARCH_FIXTURE === "1";

// Shared dist directory — built once for the entire suite.
let sharedDistDir = "";

describe("ssh remote search round-trip", () => {
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
  // Scenario 1: happy path — search workspace-seed for a known string
  // ---------------------------------------------------------------------------

  it("receives search.progress events and a valid complete for a text search", async () => {
    if (!FIXTURE_ENABLED) {
      console.warn("Skipping ssh remote search fixture: set NEXUS_RUN_SSH_SEARCH_FIXTURE=1");
      return;
    }
    if (!(await isPortOpen(FIXTURE_HOST, FIXTURE_PORT))) {
      console.warn(
        `Skipping ssh remote search fixture: ${FIXTURE_HOST}:${FIXTURE_PORT} is unavailable`,
      );
      return;
    }

    let bootstrap: BootstrapResult | null = null;
    let channel: AgentChannel | null = null;
    try {
      bootstrap = await bootstrapRemoteAgent(sharedDistDir);
      channel = openRemoteChannel(bootstrap);
      await channel.ready;

      const searchId = randomUUID();
      const progressPayloads: unknown[] = [];

      const unsubscribe = channel.on("search.progress", (payload) => {
        const p = payload as { searchId?: string };
        if (p.searchId === searchId) progressPayloads.push(payload);
      });

      let complete: unknown;
      try {
        // workspace-seed/src/hello.ts contains "function hello" — search for "hello"
        // which is guaranteed to match at least once.
        complete = await channel.call("search.text", {
          searchId,
          query: {
            pattern: "hello",
            isRegExp: false,
            isCaseSensitive: false,
            isWordMatch: false,
            includes: [],
            excludes: [],
            maxResults: 2000,
            maxFileSize: 5 * 1024 * 1024,
          },
        });
      } finally {
        unsubscribe();
      }

      // At least one progress event must arrive.
      expect(progressPayloads.length).toBeGreaterThanOrEqual(1);

      // Every progress payload must carry the correct searchId.
      for (const payload of progressPayloads) {
        const p = payload as { searchId: string; batch: unknown[] };
        expect(p.searchId).toBe(searchId);
        expect(Array.isArray(p.batch)).toBe(true);
        expect(p.batch.length).toBeGreaterThan(0);
      }

      // Complete result must report at least one match.
      const c = complete as { matchesFound: number; filesScanned: number; limitHit: boolean };
      expect(c.matchesFound).toBeGreaterThanOrEqual(1);
      expect(typeof c.filesScanned).toBe("number");
      expect(typeof c.limitHit).toBe("boolean");
    } finally {
      channel?.dispose();
      closeControlMaster(bootstrap?.controlPath);
      bootstrap?.dispose?.();
      await waitForNoControlMaster(bootstrap?.controlPath);
    }
  }, 90_000);

  // ---------------------------------------------------------------------------
  // Scenario 2: cancel — search.cancel stops an in-flight search
  // ---------------------------------------------------------------------------

  it("honours search.cancel and either rejects with cancel error or resolves with valid complete", async () => {
    if (!FIXTURE_ENABLED) {
      console.warn("Skipping ssh remote search fixture: set NEXUS_RUN_SSH_SEARCH_FIXTURE=1");
      return;
    }
    if (!(await isPortOpen(FIXTURE_HOST, FIXTURE_PORT))) {
      console.warn(
        `Skipping ssh remote search fixture: ${FIXTURE_HOST}:${FIXTURE_PORT} is unavailable`,
      );
      return;
    }

    let bootstrap: BootstrapResult | null = null;
    let channel: AgentChannel | null = null;
    try {
      bootstrap = await bootstrapRemoteAgent(sharedDistDir);
      channel = openRemoteChannel(bootstrap);
      await channel.ready;

      const searchId = randomUUID();

      // Start a broad search without awaiting — intended to be cancelled.
      const searchPromise = channel.call("search.text", {
        searchId,
        query: {
          pattern: ".",
          isRegExp: true,
          isCaseSensitive: false,
          isWordMatch: false,
          includes: [],
          excludes: [],
          maxResults: 2000,
          maxFileSize: 5 * 1024 * 1024,
        },
      });

      // Give the walk a moment to start, then cancel.
      await sleep(50);
      await channel.call("search.cancel", { searchId });

      // Both outcomes are valid per the search protocol:
      //   a) The walk finished before cancel arrived → valid complete.
      //   b) Context was cancelled → error with cancel/context/abort in message.
      try {
        const result = await searchPromise;
        const c = result as { matchesFound: number; filesScanned: number };
        expect(typeof c.matchesFound).toBe("number");
        expect(typeof c.filesScanned).toBe("number");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const msg = (error as Error).message.toLowerCase();
        expect(msg.includes("cancel") || msg.includes("context") || msg.includes("abort")).toBe(
          true,
        );
      }

      // The channel must remain usable after a cancelled search.
      const aliveId = randomUUID();
      const aliveResult = await channel.call("search.text", {
        searchId: aliveId,
        query: {
          pattern: "hello",
          isRegExp: false,
          isCaseSensitive: false,
          isWordMatch: false,
          includes: [],
          excludes: [],
          maxResults: 2000,
          maxFileSize: 5 * 1024 * 1024,
        },
      });
      const alive = aliveResult as { matchesFound: number };
      expect(alive.matchesFound).toBeGreaterThanOrEqual(1);
    } finally {
      channel?.dispose();
      closeControlMaster(bootstrap?.controlPath);
      bootstrap?.dispose?.();
      await waitForNoControlMaster(bootstrap?.controlPath);
    }
  }, 90_000);
});
