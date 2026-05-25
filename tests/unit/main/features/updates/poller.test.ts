/**
 * Unit tests for pollGithubReleases — GitHub Releases fetch, channel filtering,
 * draft exclusion, semver comparison, and error handling.
 *
 * Determinism is achieved by injecting a mock fetch via the `fetchImpl` argument
 * rather than making real network calls.
 *
 * Conventions followed:
 * - Library behaviour (semver itself, fetch itself) is NOT re-verified per conventions.md.
 * - Each test verifies one distinct scenario (observable output shape).
 */

import { describe, expect, test } from "bun:test";
import { pollGithubReleases } from "../../../../../src/main/features/updates/poller";

// ---------------------------------------------------------------------------
// Helpers — build minimal GitHub release objects
// ---------------------------------------------------------------------------

interface FakeRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

function release(
  tag: string,
  opts: Partial<{ draft: boolean; prerelease: boolean; url: string }> = {},
): FakeRelease {
  return {
    tag_name: tag,
    html_url: opts.url ?? `https://github.com/example/repo/releases/tag/${tag}`,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? false,
  };
}

/** Build a mock fetch that returns a JSON array (HTTP 200). */
function fetchOk(releases: FakeRelease[]): typeof fetch {
  return async () =>
    ({
      ok: true,
      status: 200,
      json: async () => releases,
    }) as Response;
}

/** Build a mock fetch that returns a non-OK HTTP status. */
function fetchStatus(status: number): typeof fetch {
  return async () =>
    ({
      ok: false,
      status,
      json: async () => [],
    }) as unknown as Response;
}

/** Build a mock fetch that throws a network error. */
function fetchThrows(message: string): typeof fetch {
  return async () => {
    throw new Error(message);
  };
}

// ---------------------------------------------------------------------------
// Case 1 — empty releases → kind:"current"
// ---------------------------------------------------------------------------

describe("pollGithubReleases — empty array", () => {
  test("returns current when releases list is empty", async () => {
    const result = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchOk([]),
    });
    expect(result.kind).toBe("current");
    if (result.kind === "current") {
      expect(result.current).toBe("0.1.0");
    }
  });
});

// ---------------------------------------------------------------------------
// Case 2 — stable channel filters out prereleases
// ---------------------------------------------------------------------------

describe("pollGithubReleases — stable channel", () => {
  test("returns 0.2.0 newer (ignores prerelease 0.1.5-beta.1) on stable channel", async () => {
    const releases = [
      release("0.2.0"),
      release("0.1.5-beta.1", { prerelease: true }),
    ];
    const result = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchOk(releases),
    });
    expect(result.kind).toBe("newer");
    if (result.kind === "newer") {
      expect(result.latest).toBe("0.2.0");
    }
  });
});

// ---------------------------------------------------------------------------
// Case 3 — beta channel includes prereleases; highest semver wins
// ---------------------------------------------------------------------------

describe("pollGithubReleases — beta channel", () => {
  test("returns 0.2.0 newer on beta channel (0.2.0 > 0.1.5-beta.1 per semver)", async () => {
    const releases = [
      release("0.2.0"),
      release("0.1.5-beta.1", { prerelease: true }),
    ];
    const result = await pollGithubReleases({
      channel: "beta",
      currentVersion: "0.1.0",
      fetchImpl: fetchOk(releases),
    });
    // 0.2.0 is the highest; rcompare puts it first.
    expect(result.kind).toBe("newer");
    if (result.kind === "newer") {
      expect(result.latest).toBe("0.2.0");
    }
  });
});

// ---------------------------------------------------------------------------
// Case 4 — latest tag equals currentVersion → kind:"current"
// ---------------------------------------------------------------------------

describe("pollGithubReleases — same version", () => {
  test("returns current when latest equals currentVersion", async () => {
    const result = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchOk([release("0.1.0")]),
    });
    expect(result.kind).toBe("current");
  });
});

// ---------------------------------------------------------------------------
// Case 5 — latest tag is older than currentVersion → kind:"current"
// ---------------------------------------------------------------------------

describe("pollGithubReleases — older remote version", () => {
  test("returns current when remote latest is older than currentVersion", async () => {
    const result = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.2.0",
      fetchImpl: fetchOk([release("0.0.5")]),
    });
    expect(result.kind).toBe("current");
  });
});

// ---------------------------------------------------------------------------
// Case 6 — fetch throws → kind:"error"
// ---------------------------------------------------------------------------

describe("pollGithubReleases — network error", () => {
  test("returns error when fetch throws", async () => {
    const result = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchThrows("ECONNREFUSED"),
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/ECONNREFUSED/);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 7 — HTTP 403 rate limit → kind:"error" with "403" in message
// ---------------------------------------------------------------------------

describe("pollGithubReleases — HTTP 403", () => {
  test("returns error with 403 in message on rate-limit response", async () => {
    const result = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchStatus(403),
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/403/);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 8 — "v" prefix tag → coerced via valid() strip logic → 0.2.0 newer
// ---------------------------------------------------------------------------

describe("pollGithubReleases — v-prefixed tag", () => {
  test("coerces v0.2.0 tag to 0.2.0 and reports newer", async () => {
    const result = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchOk([release("v0.2.0")]),
    });
    expect(result.kind).toBe("newer");
    if (result.kind === "newer") {
      expect(result.latest).toBe("0.2.0");
    }
  });
});

// ---------------------------------------------------------------------------
// Case 9 — draft excluded; non-draft candidate wins
// ---------------------------------------------------------------------------

describe("pollGithubReleases — draft exclusion", () => {
  test("excludes draft 0.3.0 and returns 0.2.0 as the latest newer", async () => {
    const releases = [
      release("0.3.0", { draft: true }),
      release("0.2.0"),
    ];
    const result = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchOk(releases),
    });
    expect(result.kind).toBe("newer");
    if (result.kind === "newer") {
      expect(result.latest).toBe("0.2.0");
    }
  });
});
