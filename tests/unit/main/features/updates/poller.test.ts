/**
 * Unit tests for pollGithubReleases.
 *
 * The poller reads release artifacts served off github.com (NOT the rate-
 * limited api.github.com REST endpoint):
 *   - stable channel → `releases/latest/download/latest-mac.yml` (version field)
 *   - beta channel   → `releases.atom` (highest tag across all entries)
 *
 * Determinism is achieved by injecting a mock fetch via `fetchImpl` rather than
 * making real network calls.
 *
 * Conventions followed:
 * - Library behaviour (semver itself, fetch itself) is NOT re-verified per conventions.md.
 * - Each test verifies one distinct scenario (observable output shape).
 */

import { describe, expect, test } from "bun:test";
import {
  createConditionalCache,
  pollGithubReleases,
} from "../../../../../src/main/features/updates/poller";

// ---------------------------------------------------------------------------
// Helpers — build minimal source payloads
// ---------------------------------------------------------------------------

/** Build a minimal `latest-mac.yml` body for the stable channel. */
function latestYml(version: string): string {
  return [
    `version: ${version}`,
    "files:",
    `  - url: NexusCode-${version}-arm64.zip`,
    "    sha512: AAAA==",
    "    size: 1",
    `path: NexusCode-${version}-arm64.zip`,
    "sha512: AAAA==",
    "releaseDate: '2026-05-29T00:00:00.000Z'",
  ].join("\n");
}

/** Build a minimal `releases.atom` body listing the given tags, newest first. */
function atomFeed(tags: string[]): string {
  const entries = tags
    .map(
      (tag) => `  <entry>
    <title>${tag}</title>
    <link rel="alternate" type="text/html" href="https://github.com/moreih29/nexus-code/releases/tag/${tag}"/>
  </entry>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Release notes from nexus-code</title>
${entries}
</feed>`;
}

/** Mock fetch returning a 200 with the given text body. */
function fetchOkText(body: string, etag?: string): typeof fetch {
  return async () =>
    ({
      ok: true,
      status: 200,
      headers: {
        get(name: string): string | null {
          return name.toLowerCase() === "etag" ? (etag ?? null) : null;
        },
      },
      text: async () => body,
    }) as unknown as Response;
}

/** Mock fetch returning a non-OK HTTP status. */
function fetchStatus(status: number): typeof fetch {
  return async () =>
    ({
      ok: false,
      status,
      headers: { get: () => null },
      text: async () => "",
    }) as unknown as Response;
}

/** Mock fetch that throws a network error. */
function fetchThrows(message: string): typeof fetch {
  return async () => {
    throw new Error(message);
  };
}

// ---------------------------------------------------------------------------
// Case 1 — empty stable metadata (no version) → kind:"current"
// ---------------------------------------------------------------------------

describe("pollGithubReleases — unparsable stable metadata", () => {
  test("returns current when latest-mac.yml has no version field", async () => {
    const result = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchOkText("files:\n  - url: x.zip\n"),
    });
    expect(result.kind).toBe("current");
    if (result.kind === "current") {
      expect(result.current).toBe("0.1.0");
    }
  });
});

// ---------------------------------------------------------------------------
// Case 2 — stable channel reads version from latest-mac.yml
// ---------------------------------------------------------------------------

describe("pollGithubReleases — stable channel", () => {
  test("returns 0.2.0 newer from latest-mac.yml version field", async () => {
    const result = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchOkText(latestYml("0.2.0")),
    });
    expect(result.kind).toBe("newer");
    if (result.kind === "newer") {
      expect(result.latest).toBe("0.2.0");
      expect(result.releaseUrl).toBe(
        "https://github.com/moreih29/nexus-code/releases/tag/v0.2.0",
      );
    }
  });

  test("404 on stable (no stable release yet) is treated as current", async () => {
    const result = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchStatus(404),
    });
    expect(result.kind).toBe("current");
  });
});

// ---------------------------------------------------------------------------
// Case 3 — beta channel picks highest semver tag from the Atom feed
// ---------------------------------------------------------------------------

describe("pollGithubReleases — beta channel", () => {
  test("returns highest tag across entries (0.2.0 > 0.1.5-beta.1)", async () => {
    const result = await pollGithubReleases({
      channel: "beta",
      currentVersion: "0.1.0",
      fetchImpl: fetchOkText(atomFeed(["v0.1.5-beta.1", "v0.2.0", "v0.1.0"])),
    });
    expect(result.kind).toBe("newer");
    if (result.kind === "newer") {
      expect(result.latest).toBe("0.2.0");
    }
  });

  test("beta includes a prerelease when it is the highest version", async () => {
    const result = await pollGithubReleases({
      channel: "beta",
      currentVersion: "0.2.0",
      fetchImpl: fetchOkText(atomFeed(["v0.3.0-beta.1", "v0.2.0"])),
    });
    expect(result.kind).toBe("newer");
    if (result.kind === "newer") {
      expect(result.latest).toBe("0.3.0-beta.1");
    }
  });
});

// ---------------------------------------------------------------------------
// Case 4 — latest equals currentVersion → kind:"current"
// ---------------------------------------------------------------------------

describe("pollGithubReleases — same version", () => {
  test("returns current when latest equals currentVersion", async () => {
    const result = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.2.0",
      fetchImpl: fetchOkText(latestYml("0.2.0")),
    });
    expect(result.kind).toBe("current");
  });
});

// ---------------------------------------------------------------------------
// Case 5 — latest is older than currentVersion → kind:"current"
// ---------------------------------------------------------------------------

describe("pollGithubReleases — older remote version", () => {
  test("returns current when remote latest is older than currentVersion", async () => {
    const result = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.2.0",
      fetchImpl: fetchOkText(latestYml("0.0.5")),
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
// Case 7 — HTTP 403/429 → kind:"error" with a friendly (non-raw) message
// ---------------------------------------------------------------------------

describe("pollGithubReleases — rate limited", () => {
  test("403 yields a friendly retry-later message, not a raw status dump", async () => {
    const result = await pollGithubReleases({
      channel: "beta",
      currentVersion: "0.1.0",
      fetchImpl: fetchStatus(403),
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/잠시 후 다시 시도/);
      expect(result.message).not.toMatch(/rate limit exceeded for/);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 8 — non-v-prefixed version in yml still parses
// ---------------------------------------------------------------------------

describe("pollGithubReleases — version without v prefix", () => {
  test("parses a bare semver version from latest-mac.yml", async () => {
    const result = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchOkText("version: 0.2.0\n"),
    });
    expect(result.kind).toBe("newer");
    if (result.kind === "newer") {
      expect(result.latest).toBe("0.2.0");
    }
  });
});

// ---------------------------------------------------------------------------
// Case 9 — non-semver tags in the atom feed are skipped
// ---------------------------------------------------------------------------

describe("pollGithubReleases — atom feed with noise", () => {
  test("ignores non-semver tags and picks the highest valid one", async () => {
    const result = await pollGithubReleases({
      channel: "beta",
      currentVersion: "0.1.0",
      fetchImpl: fetchOkText(atomFeed(["nightly", "v0.2.0", "latest"])),
    });
    expect(result.kind).toBe("newer");
    if (result.kind === "newer") {
      expect(result.latest).toBe("0.2.0");
    }
  });
});

// ---------------------------------------------------------------------------
// Case 10 — ETag conditional request: first poll stores ETag + resolution,
// second poll sends If-None-Match and reuses the cached resolution on 304.
//
// Pins the rate-limit-savings contract: a 304 resolves without re-reading the
// body, so repeated polls stay cheap until the latest release changes.
// ---------------------------------------------------------------------------

describe("pollGithubReleases — ETag conditional requests", () => {
  test("second poll sends If-None-Match and resolves from cache on 304", async () => {
    const cache = createConditionalCache();
    const seenIfNoneMatch: Array<string | undefined> = [];

    const fetchImpl: typeof fetch = async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenIfNoneMatch.push(headers["If-None-Match"]);
      if (headers["If-None-Match"] === '"v1"') {
        return {
          ok: false,
          status: 304,
          headers: {
            get(name: string): string | null {
              return name.toLowerCase() === "etag" ? '"v1"' : null;
            },
          },
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: {
          get(name: string): string | null {
            return name.toLowerCase() === "etag" ? '"v1"' : null;
          },
        },
        text: async () => latestYml("0.2.0"),
      } as unknown as Response;
    };

    const r1 = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl,
      cache,
    });
    expect(r1.kind).toBe("newer");
    if (r1.kind === "newer") expect(r1.latest).toBe("0.2.0");
    expect(seenIfNoneMatch[0]).toBeUndefined();
    expect(cache.etag).toBe('"v1"');
    expect(cache.resolved?.version).toBe("0.2.0");

    const r2 = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl,
      cache,
    });
    expect(seenIfNoneMatch[1]).toBe('"v1"');
    expect(r2.kind).toBe("newer");
    if (r2.kind === "newer") expect(r2.latest).toBe("0.2.0");
  });

  test("a stale ETag from a different channel's source is not reused", async () => {
    // Cache holds an ETag minted for the beta (atom) source; a stable poll
    // must NOT send it, since If-None-Match is only valid for the same URL.
    const cache = createConditionalCache();
    cache.etag = '"beta-etag"';
    cache.sourceUrl = "https://github.com/moreih29/nexus-code/releases.atom";
    cache.resolved = { version: "9.9.9", releaseUrl: null };

    let sentIfNoneMatch: string | undefined = "unset";
    const fetchImpl: typeof fetch = async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sentIfNoneMatch = headers["If-None-Match"];
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => latestYml("0.2.0"),
      } as unknown as Response;
    };

    const result = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl,
      cache,
    });
    expect(sentIfNoneMatch).toBeUndefined();
    expect(result.kind).toBe("newer");
    if (result.kind === "newer") expect(result.latest).toBe("0.2.0");
  });

  test("304 with no cached resolution is reported as a protocol error", async () => {
    const cache = createConditionalCache();
    cache.etag = '"v1"';
    cache.sourceUrl = "https://github.com/moreih29/nexus-code/releases/latest/download/latest-mac.yml";
    // resolved intentionally left null — synthetic invariant violation.
    const fetchImpl: typeof fetch = async () =>
      ({
        ok: false,
        status: 304,
        headers: { get: () => null },
      }) as unknown as Response;

    const result = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl,
      cache,
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/304/);
    }
  });
});
