/**
 * GitHub Releases poller for the app-update domain.
 *
 * Fetches the repository's release list, filters by channel, picks the
 * latest semver tag, and returns a typed PollResult.
 *
 * The optional `fetchImpl` parameter enables deterministic unit tests by
 * injecting a mock `fetch` implementation — in production the module-level
 * `fetch` is used (available in Node 18+/Electron 22+).
 */

import { gt, rcompare, valid } from "semver";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PollResult =
  | { kind: "newer"; current: string; latest: string; releaseUrl: string }
  | { kind: "current"; current: string; latest?: string }
  | { kind: "error"; message: string };

/**
 * Mutable HTTP conditional-request cache.
 *
 * Holds the most recent ETag plus the parsed release list that ETag refers
 * to. Reused across consecutive `pollGithubReleases` calls so subsequent
 * polls can send `If-None-Match` and let GitHub respond with 304 Not Modified
 * when nothing changed.
 *
 * Why this matters: GitHub does not count 304 responses against the
 * unauthenticated rate limit (60 req/h per IP). A single shared cache keeps
 * ongoing polls effectively free until the release list actually changes —
 * the failure mode we previously hit ("API rate limit exceeded for <ip>")
 * stops occurring under normal usage.
 */
export interface ConditionalCache {
  etag: string | null;
  releases: GithubRelease[] | null;
}

/** Construct a fresh cache. Production callers create one per process. */
export function createConditionalCache(): ConditionalCache {
  return { etag: null, releases: null };
}

export interface PollGithubReleasesOptions {
  /** "stable" uses only non-prerelease tags; "beta" also includes prerelease. */
  channel: "stable" | "beta";
  /** The version string reported by `app.getVersion()`. */
  currentVersion: string;
  /**
   * Optional fetch implementation.  Defaults to the global `fetch`.
   * Inject a mock here for unit tests to avoid real network calls.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional ETag cache shared across polls. When omitted, every call behaves
   * like the first (no `If-None-Match` header sent, no caching). Production
   * code in `installUpdatesDomain` supplies a single instance per process so
   * 304 responses cover the typical case where the release list is unchanged.
   */
  cache?: ConditionalCache;
}

// ---------------------------------------------------------------------------
// GitHub API shape (minimal subset we care about)
// ---------------------------------------------------------------------------

interface GithubRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const RELEASES_URL = "https://api.github.com/repos/moreih29/nexus-code/releases";

/**
 * Fetch the GitHub release list and return a `PollResult`.
 *
 * Errors (network failures, unexpected response shapes) are caught and
 * surfaced as `{ kind: "error", message }` so callers never have to try/catch.
 */
export async function pollGithubReleases(options: PollGithubReleasesOptions): Promise<PollResult> {
  const { channel, currentVersion, fetchImpl = fetch, cache } = options;

  let releases: GithubRelease[];

  try {
    // GitHub API requires a User-Agent header on every request — unauthenticated
    // calls without UA are rejected outright (typically with HTTP 403). The
    // value is intentionally a recognizable static string so GH abuse-detection
    // can attribute requests to this app rather than to a generic UA.
    // X-GitHub-Api-Version pins the response shape so a future v4 default
    // doesn't silently change `tag_name`/`prerelease` semantics on us.
    //
    // If-None-Match enables conditional requests: when GitHub recognizes the
    // ETag we previously stored, it responds with 304 Not Modified and the
    // request is not counted toward the unauthenticated rate limit. We only
    // attach the header when we actually have a cached ETag.
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "nexus-code-update-checker",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (cache?.etag !== null && cache?.etag !== undefined) {
      headers["If-None-Match"] = cache.etag;
    }

    const response = await fetchImpl(RELEASES_URL, { headers });

    // 304 Not Modified — reuse the cached release list. This is the common
    // path once a cache is warm; it costs zero rate-limit units. The
    // `cache.releases === null` branch is defensive: we only ever send
    // `If-None-Match` when `cache.etag` was set, and we set `etag` and
    // `releases` together below, so a 304 without a cached body would be
    // an invariant violation rather than an expected case.
    if (response.status === 304) {
      if (!cache || cache.releases === null) {
        return {
          kind: "error",
          message: "Received HTTP 304 with no cached release list",
        };
      }
      releases = cache.releases;
    } else if (!response.ok) {
      // Surface the body's `message` field when available — for 403s this
      // distinguishes a missing-UA rejection from a rate-limit hit, which
      // require different fixes. Failures to read the body are non-fatal:
      // we still return a useful status code.
      let detail = "";
      try {
        const body = (await response.json()) as { message?: string };
        if (typeof body.message === "string" && body.message.length > 0) {
          detail = ` — ${body.message}`;
        }
      } catch {
        // ignore: response body might not be JSON, status alone is fine
      }
      return {
        kind: "error",
        message: `GitHub API responded with HTTP ${response.status}${detail}`,
      };
    } else {
      const json = (await response.json()) as unknown;
      if (!Array.isArray(json)) {
        return { kind: "error", message: "Unexpected GitHub API response shape" };
      }
      releases = json as GithubRelease[];

      // Save the ETag + parsed body for the next conditional request. Both
      // are stored together: a future 304 must be able to resolve to the
      // exact list that produced this ETag.
      if (cache !== undefined) {
        cache.etag = response.headers.get("etag");
        cache.releases = releases;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", message: `Network error: ${message}` };
  }

  // Filter out drafts; keep prereleases only when channel is "beta".
  const candidates = releases.filter((r) => {
    if (r.draft) return false;
    if (r.prerelease && channel !== "beta") return false;
    return true;
  });

  // Strip leading "v" and validate semver before sorting.
  type ScoredRelease = { version: string; releaseUrl: string };
  const scored: ScoredRelease[] = [];
  for (const r of candidates) {
    const raw = r.tag_name.startsWith("v") ? r.tag_name.slice(1) : r.tag_name;
    if (valid(raw)) {
      scored.push({ version: raw, releaseUrl: r.html_url });
    }
  }

  if (scored.length === 0) {
    return { kind: "current", current: currentVersion };
  }

  // Sort descending by semver (highest version first).
  // `rcompare` handles prerelease versions correctly per SemVer spec:
  // 1.0.0-beta.1 < 1.0.0, so stable releases sort above prerelease of the
  // same major.minor.patch. This is the desired behavior.
  scored.sort((a, b) => rcompare(a.version, b.version));

  const { version: latestVersion, releaseUrl } = scored[0];

  const isNewer = gt(latestVersion, currentVersion);
  if (isNewer) {
    return {
      kind: "newer",
      current: currentVersion,
      latest: latestVersion,
      releaseUrl,
    };
  }

  return { kind: "current", current: currentVersion, latest: latestVersion };
}
