/**
 * Release poller for the app-update domain.
 *
 * Determines the latest available version for the active channel and returns a
 * typed PollResult. Crucially this does NOT use `api.github.com` — that REST
 * endpoint imposes a 60 requests/hour PER-IP limit on unauthenticated callers,
 * shared across every unauthenticated GitHub API request from that IP. A
 * desktop app that polls on launch (and on every "Check for Updates" click)
 * exhausts that budget easily on shared/NAT networks, surfacing as
 * "API rate limit exceeded for <ip>" (HTTP 403).
 *
 * Instead we read the artifacts the release pipeline already publishes, served
 * from github.com / its CDN (generous limits, not the 60/h API bucket):
 *
 *   stable → `releases/latest/download/latest-mac.yml`
 *            `releases/latest` resolves to the newest NON-prerelease release,
 *            which is exactly stable-channel semantics. The electron-updater
 *            metadata file carries a `version:` field we parse directly.
 *
 *   beta   → `releases.atom`
 *            The Atom feed lists every published (non-draft) release newest
 *            first; the release tag lives in each entry's link URL. Beta wants
 *            the highest version regardless of prerelease status, so we collect
 *            all tags and pick the max semver — no prerelease flag needed.
 *
 * The optional `fetchImpl` parameter enables deterministic unit tests by
 * injecting a mock `fetch`; production uses the global `fetch` (Electron 22+).
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
 * Holds the most recent ETag, the source URL that ETag refers to, and the
 * resolved candidate that source produced. Reused across consecutive
 * `pollGithubReleases` calls so a subsequent poll can send `If-None-Match`
 * and let the server reply 304 Not Modified when nothing changed — cheaper
 * and faster than re-downloading + re-parsing.
 *
 * `sourceUrl` is tracked because switching channel (stable ↔ beta) changes
 * the source: an ETag minted for one URL must not be sent against the other.
 */
export interface ConditionalCache {
  etag: string | null;
  sourceUrl: string | null;
  resolved: ResolvedCandidate | null;
}

/** The latest candidate distilled from a source response. */
interface ResolvedCandidate {
  /** Highest semver found (without leading "v"), or null when none qualify. */
  version: string | null;
  /** Canonical release page URL for that version (only when version != null). */
  releaseUrl: string | null;
}

/** Construct a fresh cache. Production callers create one per process. */
export function createConditionalCache(): ConditionalCache {
  return { etag: null, sourceUrl: null, resolved: null };
}

export interface PollGithubReleasesOptions {
  /** "stable" reads releases/latest; "beta" reads the Atom feed. */
  channel: "stable" | "beta";
  /** The version string reported by `app.getVersion()`. */
  currentVersion: string;
  /**
   * Optional fetch implementation. Defaults to the global `fetch`.
   * Inject a mock here for unit tests to avoid real network calls.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional ETag cache shared across polls. When omitted, every call behaves
   * like the first (no `If-None-Match` sent, no caching). Production code in
   * `installUpdatesDomain` supplies one instance per process so 304 responses
   * cover the typical case where the latest release is unchanged.
   */
  cache?: ConditionalCache;
}

// ---------------------------------------------------------------------------
// Source URLs
// ---------------------------------------------------------------------------

const REPO_BASE = "https://github.com/moreih29/nexus-code";
/** Stable: electron-updater metadata for the latest non-prerelease release. */
const STABLE_URL = `${REPO_BASE}/releases/latest/download/latest-mac.yml`;
/** Beta: Atom feed of all published releases (prereleases included). */
const BETA_URL = `${REPO_BASE}/releases.atom`;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Fetch the latest version for the channel and return a `PollResult`.
 *
 * Errors (network failures, rate limits, unexpected shapes) are caught and
 * surfaced as `{ kind: "error", message }` so callers never have to try/catch.
 */
export async function pollGithubReleases(options: PollGithubReleasesOptions): Promise<PollResult> {
  const { channel, currentVersion, fetchImpl = fetch, cache } = options;

  const sourceUrl = channel === "stable" ? STABLE_URL : BETA_URL;

  let resolved: ResolvedCandidate;

  try {
    // If-None-Match is only valid for the SAME resource the ETag came from.
    // After a channel switch the source URL differs, so drop the stale ETag.
    const haveValidCache =
      cache?.etag != null && cache.sourceUrl === sourceUrl && cache.resolved !== null;

    const headers: Record<string, string> = {
      // A descriptive UA keeps GitHub abuse-detection attributing requests to
      // this app rather than a generic client.
      "User-Agent": "nexus-code-update-checker",
    };
    if (haveValidCache && cache?.etag != null) {
      headers["If-None-Match"] = cache.etag;
    }

    const response = await fetchImpl(sourceUrl, { headers });

    if (response.status === 304) {
      // Not Modified — reuse the cached resolution. We only send If-None-Match
      // when we have a cached resolution for this exact source, so a 304
      // without one is an invariant violation worth surfacing.
      if (!haveValidCache || !cache || cache.resolved === null) {
        return { kind: "error", message: "Received HTTP 304 with no cached result" };
      }
      resolved = cache.resolved;
    } else if (response.status === 404 && channel === "stable") {
      // No stable release published yet (only prereleases). Not an error —
      // there is simply nothing newer on the stable channel.
      return { kind: "current", current: currentVersion };
    } else if (!response.ok) {
      return { kind: "error", message: describeHttpError(response.status) };
    } else {
      const text = await response.text();
      resolved =
        channel === "stable" ? parseLatestYml(text, REPO_BASE) : parseAtomFeed(text);

      if (cache !== undefined) {
        cache.etag = response.headers.get("etag");
        cache.sourceUrl = sourceUrl;
        cache.resolved = resolved;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", message: `Network error: ${message}` };
  }

  const { version: latestVersion, releaseUrl } = resolved;

  // No qualifying version found in the source.
  if (latestVersion === null || !valid(latestVersion)) {
    return { kind: "current", current: currentVersion };
  }

  if (gt(latestVersion, currentVersion)) {
    return {
      kind: "newer",
      current: currentVersion,
      latest: latestVersion,
      releaseUrl: releaseUrl ?? `${REPO_BASE}/releases/tag/v${latestVersion}`,
    };
  }

  return { kind: "current", current: currentVersion, latest: latestVersion };
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Extract the `version:` field from an electron-updater `latest-mac.yml`.
 * The file is simple, flat YAML; we read the single field we need with a
 * regex rather than pulling in a YAML dependency.
 */
function parseLatestYml(text: string, repoBase: string): ResolvedCandidate {
  const match = text.match(/^version:\s*(.+?)\s*$/m);
  if (!match) {
    return { version: null, releaseUrl: null };
  }
  // Strip optional surrounding quotes, then a leading "v".
  const raw = match[1].replace(/^['"]|['"]$/g, "");
  const version = raw.startsWith("v") ? raw.slice(1) : raw;
  return {
    version,
    releaseUrl: `${repoBase}/releases/tag/v${version}`,
  };
}

/**
 * Pick the highest semver tag from a GitHub `releases.atom` feed.
 * Each entry's release tag lives in its link URL (`.../releases/tag/<tag>`);
 * the feed never lists drafts. Beta takes the max version across all entries,
 * so prerelease status is irrelevant here.
 */
function parseAtomFeed(text: string): ResolvedCandidate {
  const tagRe = /\/releases\/tag\/([^"'<\s]+)/g;
  let best: { version: string; tag: string } | null = null;

  for (const m of text.matchAll(tagRe)) {
    const tag = decodeURIComponent(m[1]);
    const version = tag.startsWith("v") ? tag.slice(1) : tag;
    if (!valid(version)) continue;
    if (best === null || rcompare(version, best.version) < 0) {
      best = { version, tag };
    }
  }

  if (best === null) {
    return { version: null, releaseUrl: null };
  }
  return {
    version: best.version,
    releaseUrl: `${REPO_BASE}/releases/tag/${best.tag}`,
  };
}

// ---------------------------------------------------------------------------
// Error messaging
// ---------------------------------------------------------------------------

/**
 * Map an HTTP status to a user-facing message. Rate-limit / forbidden / too-
 * many-requests get a friendly "try again later" rather than a raw status,
 * since those are transient and the previous raw GitHub message ("API rate
 * limit exceeded for <ip>...") confused users into thinking the app misbehaved.
 */
function describeHttpError(status: number): string {
  if (status === 403 || status === 429) {
    return "GitHub 요청이 일시적으로 제한되었습니다. 잠시 후 다시 시도해 주세요.";
  }
  return `업데이트 정보를 가져오지 못했습니다 (HTTP ${status}).`;
}
