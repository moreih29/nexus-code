import { describe, expect, test } from "bun:test";
import {
  createConditionalCache,
  pollGithubReleases,
} from "../../../../../src/main/features/updates/poller";
import { oversizedResponse } from "../../../../helpers/http-fixtures";

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

function fetchOkText(body: string, etag?: string): typeof fetch {
  return async () => new Response(body, etag ? { headers: { etag } } : undefined);
}

function fetchStatus(status: number): typeof fetch {
  return async () => new Response(null, { status });
}

function fetchThrows(message: string): typeof fetch {
  return async () => {
    throw new Error(message);
  };
}

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
      expect(result.releaseUrl).toBe("https://github.com/moreih29/nexus-code/releases/tag/v0.2.0");
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

describe("pollGithubReleases — network error", () => {
  test("returns error when fetch throws", async () => {
    const result = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: fetchThrows("ECONNREFUSED"),
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toBe("network");
      expect(result.message).toMatch(/ECONNREFUSED/);
    }
  });
});

describe("pollGithubReleases — rate limited", () => {
  test("403 is reported as rate-limited, not a raw status dump", async () => {
    const result = await pollGithubReleases({
      channel: "beta",
      currentVersion: "0.1.0",
      fetchImpl: fetchStatus(403),
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toBe("rate-limited");
      expect(result.message).not.toMatch(/rate limit exceeded for/);
    }
  });
});

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

describe("pollGithubReleases — ETag conditional requests", () => {
  test("second poll sends If-None-Match and resolves from cache on 304", async () => {
    const cache = createConditionalCache();
    const seenIfNoneMatch: Array<string | undefined> = [];

    const fetchImpl: typeof fetch = async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenIfNoneMatch.push(headers["If-None-Match"]);
      if (headers["If-None-Match"] === '"v1"') {
        return new Response(null, { status: 304, headers: { etag: '"v1"' } });
      }
      return new Response(latestYml("0.2.0"), { headers: { etag: '"v1"' } });
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
    const cache = createConditionalCache();
    cache.etag = '"beta-etag"';
    cache.sourceUrl = "https://github.com/moreih29/nexus-code/releases.atom";
    cache.resolved = { version: "9.9.9", releaseUrl: null };

    let sentIfNoneMatch: string | undefined = "unset";
    const fetchImpl: typeof fetch = async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sentIfNoneMatch = headers["If-None-Match"];
      return new Response(latestYml("0.2.0"));
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
    cache.sourceUrl =
      "https://github.com/moreih29/nexus-code/releases/latest/download/latest-mac.yml";
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 304 });

    const result = await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl,
      cache,
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toBe("unexpected");
      expect(result.message).toMatch(/304/);
    }
  });
});

test("the update poller cancels an oversized body before parsing it", async () => {
  const response = oversizedResponse(8);
  expect(
    await pollGithubReleases({
      channel: "stable",
      currentVersion: "0.1.0",
      fetchImpl: response.fetch,
    }),
  ).toMatchObject({ kind: "error", reason: "response-too-large" });
  expect(response.cancelled()).toBe(true);
});

test("a conditional reply uses the candidate from its own request", async () => {
  const cache = createConditionalCache();
  await pollGithubReleases({
    cache,
    channel: "stable",
    currentVersion: "1.0.0",
    fetchImpl: async () => new Response("version: 2.0.0", { headers: { etag: '"stable"' } }),
  });
  const conditional = Promise.withResolvers<Response>();
  const stable = pollGithubReleases({
    cache,
    channel: "stable",
    currentVersion: "1.0.0",
    fetchImpl: async (_url, init) => {
      expect(new Headers(init?.headers).get("If-None-Match")).toBe('"stable"');
      return conditional.promise;
    },
  });
  await pollGithubReleases({
    cache,
    channel: "beta",
    currentVersion: "1.0.0",
    fetchImpl: async () =>
      new Response('<link href="https://example.test/releases/tag/v3.0.0-beta.1"/>'),
  });
  conditional.resolve(new Response(null, { status: 304 }));

  expect(await stable).toMatchObject({ kind: "newer", latest: "2.0.0" });
});
