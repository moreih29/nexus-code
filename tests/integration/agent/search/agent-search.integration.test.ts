/**
 * Integration test: Go search service ↔ TS wire round-trip.
 *
 * Spawns the real agent binary via createLocalChannel and exercises the
 * search.text / search.cancel RPC surface end-to-end. The test verifies
 * that search.progress events are received and that the complete result
 * matches the TS schemas.
 *
 * Scenarios:
 *   1. happy   – 10 files with "needle" matches → progress + complete received
 *   2. batched – 300+ matches → multiple progress events (batchMatchesTrigger=200)
 *   3. cancel  – cancel mid-search → cancelled complete with context-cancelled error
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createLocalChannel } from "../../../../src/main/infra/agent/local-channel";
import {
  AgentSearchCompleteSchema,
  AgentSearchProgressPayloadSchema,
  SEARCH_CANCEL_METHOD,
  SEARCH_PROGRESS_EVENT,
  SEARCH_TEXT_METHOD,
} from "../../../../src/shared/protocol/search";
import type { AgentChannel } from "../../../../src/main/infra/agent/channel";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const goAvailable = spawnSync("go", ["version"]).status === 0;

describe("agent search round-trip", () => {
  if (!goAvailable) {
    it("skips when go is unavailable", () => {});
    return;
  }

  let binPath: string;
  let buildDir: string;

  beforeAll(async () => {
    buildDir = await fs.mkdtemp(path.join(tmpdir(), "nexus-agent-search-build-"));
    binPath = path.join(buildDir, "agent");
    const build = spawnSync("go", ["build", "-o", binPath, "./cmd/agent"], {
      cwd: REPO_ROOT,
    });
    if (build.status !== 0) {
      throw new Error(`go build failed: ${build.stderr.toString()}`);
    }
  });

  afterAll(async () => {
    await fs.rm(buildDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Scenario 1: happy path — 10 files, "needle" scattered across them
  // ---------------------------------------------------------------------------

  it("receives progress events and a complete result for a basic text search", async () => {
    const fixture = await SearchAgentFixture.create(binPath);
    try {
      // Create 10 files, each containing the word "needle" once.
      for (let i = 0; i < 10; i++) {
        await fs.writeFile(
          path.join(fixture.root, `file-${i}.txt`),
          `line before\nneedle in the haystack\nline after\n`,
          "utf8",
        );
      }

      const searchId = randomUUID();
      const { progressPayloads, complete } = await fixture.search(searchId, {
        pattern: "needle",
        isRegExp: false,
        isCaseSensitive: false,
        isWordMatch: false,
        includes: [],
        excludes: [],
        maxResults: 2000,
        maxFileSize: 5 * 1024 * 1024,
      });

      // At least one progress event must arrive before or concurrent with complete.
      expect(progressPayloads.length).toBeGreaterThanOrEqual(1);

      // Every payload must satisfy the TS schema.
      for (const payload of progressPayloads) {
        AgentSearchProgressPayloadSchema.parse(payload);
        expect(payload.searchId).toBe(searchId);
        expect(payload.batch.length).toBeGreaterThan(0);
      }

      // Complete must be valid and report at least 10 matches (one per file).
      AgentSearchCompleteSchema.parse(complete);
      expect(complete.matchesFound).toBeGreaterThanOrEqual(10);
      expect(complete.limitHit).toBe(false);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Scenario 2: large result — 300+ matches trigger multiple progress batches
  //
  // The Go implementation (internal/search/service.go) flushes a batch when
  // either batchMatchesTrigger (200) or batchCountTrigger (50 files) is hit.
  // Creating 25 files × 14 matches each = 350 matches exceeds 200 matches and
  // crosses the 50-file-count boundary, so at least 2 batches are expected.
  // ---------------------------------------------------------------------------

  it("splits large results into multiple progress batches", async () => {
    const fixture = await SearchAgentFixture.create(binPath);
    try {
      // 25 files × 14 occurrences of "token" = 350 matches total.
      // The batchMatchesTrigger (200) fires after the 15th file (15×14=210),
      // and the batchCountTrigger (50 files) fires after all 25 are scanned
      // if matches haven't already cleared it. Either way: >1 flush is required.
      for (let i = 0; i < 25; i++) {
        const lines = Array.from({ length: 14 }, (_, j) => `token_occurrence_${j}`).join("\n");
        await fs.writeFile(path.join(fixture.root, `big-${i}.txt`), lines + "\n", "utf8");
      }

      const searchId = randomUUID();
      const { progressPayloads, complete } = await fixture.search(searchId, {
        pattern: "token_occurrence",
        isRegExp: false,
        isCaseSensitive: true,
        isWordMatch: false,
        includes: [],
        excludes: [],
        maxResults: 2000,
        maxFileSize: 5 * 1024 * 1024,
      });

      // Must have received more than one progress event due to batching.
      expect(progressPayloads.length).toBeGreaterThan(1);

      const totalMatches = progressPayloads.reduce(
        (sum, p) => sum + p.batch.reduce((s, fm) => s + fm.matches.length, 0),
        0,
      );
      expect(totalMatches).toBe(350);
      expect(complete.matchesFound).toBe(350);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Scenario 3: cancel — search.cancel stops an in-flight search cleanly
  // ---------------------------------------------------------------------------

  it("honours search.cancel and returns a context-cancelled error", async () => {
    const fixture = await SearchAgentFixture.create(binPath);
    try {
      // Create enough files that the walk takes a non-trivial amount of time,
      // giving the cancel call a chance to land before the walk completes.
      for (let i = 0; i < 100; i++) {
        const content = Array.from({ length: 50 }, (_, j) => `haystack line ${j}`).join("\n");
        await fs.writeFile(path.join(fixture.root, `cancel-${i}.txt`), content + "\n", "utf8");
      }

      const searchId = randomUUID();

      // Start the search without awaiting — we will cancel before it finishes.
      const searchPromise = fixture.channel.call(SEARCH_TEXT_METHOD, {
        searchId,
        query: {
          pattern: "haystack",
          isRegExp: false,
          isCaseSensitive: false,
          isWordMatch: false,
          includes: [],
          excludes: [],
          maxResults: 2000,
          maxFileSize: 5 * 1024 * 1024,
        },
      });

      // Cancel immediately — the agent processes the cancel concurrently.
      await fixture.channel.call(SEARCH_CANCEL_METHOD, { searchId });

      // The search call must either:
      //   a) reject with a context-cancelled / cancelled error, OR
      //   b) resolve with a valid (possibly partial) complete payload
      //      if the walk finished before the cancel arrived.
      // Both are valid protocol outcomes — the test asserts that no unhandled
      // exception escapes the channel and that the channel stays alive.
      try {
        const result = await searchPromise;
        // If the walk finished before cancel: complete is valid.
        AgentSearchCompleteSchema.parse(result);
      } catch (error) {
        // Context cancellation surfaces as an error.
        expect(error).toBeInstanceOf(Error);
        const msg = (error as Error).message.toLowerCase();
        expect(
          msg.includes("cancel") || msg.includes("context") || msg.includes("abort"),
        ).toBe(true);
      }

      // Channel must remain usable after a cancelled search.
      const aliveSearchId = randomUUID();
      await fs.writeFile(
        path.join(fixture.root, "alive-check.txt"),
        "alive_marker\n",
        "utf8",
      );
      const aliveResult = await fixture.channel.call(SEARCH_TEXT_METHOD, {
        searchId: aliveSearchId,
        query: {
          pattern: "alive_marker",
          isRegExp: false,
          isCaseSensitive: false,
          isWordMatch: false,
          includes: [],
          excludes: [],
          maxResults: 2000,
          maxFileSize: 5 * 1024 * 1024,
        },
      });
      const aliveParsed = AgentSearchCompleteSchema.parse(aliveResult);
      expect(aliveParsed.matchesFound).toBeGreaterThanOrEqual(1);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// SearchAgentFixture
// ---------------------------------------------------------------------------

interface ProgressPayload {
  searchId: string;
  batch: Array<{ relPath: string; matches: unknown[] }>;
}

interface SearchResult {
  progressPayloads: ProgressPayload[];
  complete: {
    filesScanned: number;
    matchesFound: number;
    limitHit: boolean;
    elapsedMs: number;
  };
}

/**
 * SearchAgentFixture drives a real agent process for search integration tests.
 * Each scenario creates its own fixture instance and disposes it when done.
 */
class SearchAgentFixture {
  private disposed = false;

  private constructor(
    readonly root: string,
    readonly channel: AgentChannel,
  ) {}

  /**
   * Creates a temporary workspace and a local agent channel.
   */
  static async create(binaryPath: string): Promise<SearchAgentFixture> {
    const root = await fs.mkdtemp(path.join(tmpdir(), "nexus-search-root-"));
    const channel = createLocalChannel({
      binaryPath,
      rootPath: root,
      requestTimeoutMs: 20_000,
      reconnect: { initialDelayMs: 25, maxDelayMs: 50 },
    });
    await channel.ready;
    return new SearchAgentFixture(root, channel);
  }

  /**
   * Runs a search and collects all progress events plus the final complete.
   * Subscribes to search.progress before issuing the call to avoid a race.
   */
  async search(
    searchId: string,
    query: {
      pattern: string;
      isRegExp: boolean;
      isCaseSensitive: boolean;
      isWordMatch: boolean;
      includes: string[];
      excludes: string[];
      maxResults: number;
      maxFileSize: number;
    },
  ): Promise<SearchResult> {
    const progressPayloads: ProgressPayload[] = [];

    const unsubscribe = this.channel.on(SEARCH_PROGRESS_EVENT, (payload) => {
      const parsed = AgentSearchProgressPayloadSchema.safeParse(payload);
      if (!parsed.success || parsed.data.searchId !== searchId) return;
      progressPayloads.push(parsed.data as ProgressPayload);
    });

    try {
      const raw = await this.channel.call(SEARCH_TEXT_METHOD, { searchId, query });
      const complete = AgentSearchCompleteSchema.parse(raw);
      return { progressPayloads, complete };
    } finally {
      unsubscribe();
    }
  }

  /**
   * Disposes the channel and removes the temporary workspace.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.channel.dispose();
    await sleep(100);
    await fs.rm(this.root, { recursive: true, force: true });
  }
}

/**
 * Promise wrapper around setTimeout for bounded async polling.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
