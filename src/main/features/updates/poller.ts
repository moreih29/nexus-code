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
  const { channel, currentVersion, fetchImpl = fetch } = options;

  let releases: GithubRelease[];

  try {
    const response = await fetchImpl(RELEASES_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
      return {
        kind: "error",
        message: `GitHub API responded with HTTP ${response.status}`,
      };
    }
    const json = (await response.json()) as unknown;
    if (!Array.isArray(json)) {
      return { kind: "error", message: "Unexpected GitHub API response shape" };
    }
    releases = json as GithubRelease[];
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
