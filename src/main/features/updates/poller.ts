import { gt, rcompare, valid } from "semver";
import { ResponseTooLargeError, readResponseText } from "../../infra/http/body";

export type PollFailureReason =
  | "rate-limited"
  | "http"
  | "network"
  | "unexpected"
  | "response-too-large";

export type PollResult =
  | { kind: "newer"; current: string; latest: string; releaseUrl: string }
  | { kind: "current"; current: string; latest?: string }
  | {
      kind: "error";
      reason: PollFailureReason;
      status?: number;
      message: string;
    };

export interface ConditionalCache {
  etag: string | null;
  sourceUrl: string | null;
  resolved: ResolvedCandidate | null;
}

interface ResolvedCandidate {
  version: string | null;
  releaseUrl: string | null;
}

export function createConditionalCache(): ConditionalCache {
  return { etag: null, sourceUrl: null, resolved: null };
}

export interface PollGithubReleasesOptions {
  channel: "stable" | "beta";
  currentVersion: string;
  fetchImpl?: typeof fetch;
  cache?: ConditionalCache;
}

export const REPO_BASE = "https://github.com/moreih29/nexus-code";
const STABLE_URL = `${REPO_BASE}/releases/latest/download/latest-mac.yml`;
const BETA_URL = `${REPO_BASE}/releases.atom`;

export async function pollGithubReleases(options: PollGithubReleasesOptions): Promise<PollResult> {
  const { channel, currentVersion, fetchImpl = fetch, cache } = options;

  const sourceUrl = channel === "stable" ? STABLE_URL : BETA_URL;

  let resolved: ResolvedCandidate;

  try {
    const etag = cache?.sourceUrl === sourceUrl ? cache.etag : null;
    const cached = etag != null ? (cache?.resolved ?? null) : null;

    const headers: Record<string, string> = {
      "User-Agent": "nexus-code-update-checker",
    };
    if (etag != null && cached !== null) headers["If-None-Match"] = etag;

    const response = await fetchImpl(sourceUrl, { headers });

    if (response.status === 304) {
      if (cached === null) {
        return {
          kind: "error",
          reason: "unexpected",
          message: "Received HTTP 304 with no cached result",
        };
      }
      resolved = cached;
    } else if (response.status === 404 && channel === "stable") {
      return { kind: "current", current: currentVersion };
    } else if (!response.ok) {
      return httpError(response.status);
    } else {
      const text = await readResponseText(response);
      resolved = channel === "stable" ? parseLatestYml(text, REPO_BASE) : parseAtomFeed(text);

      if (cache !== undefined) {
        cache.etag = response.headers.get("etag");
        cache.sourceUrl = sourceUrl;
        cache.resolved = resolved;
      }
    }
  } catch (err) {
    if (err instanceof ResponseTooLargeError) {
      return { kind: "error", reason: err.code, message: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", reason: "network", message: `Network error: ${message}` };
  }

  const { version: latestVersion, releaseUrl } = resolved;

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

function parseLatestYml(text: string, repoBase: string): ResolvedCandidate {
  const match = text.match(/^version:\s*(.+?)\s*$/m);
  if (!match) {
    return { version: null, releaseUrl: null };
  }
  const raw = match[1].replace(/^['"]|['"]$/g, "");
  const version = raw.startsWith("v") ? raw.slice(1) : raw;
  return {
    version,
    releaseUrl: `${repoBase}/releases/tag/v${version}`,
  };
}

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

function httpError(status: number): PollResult {
  if (status === 403 || status === 429) {
    return {
      kind: "error",
      reason: "rate-limited",
      status,
      message: `GitHub rate-limited the request (HTTP ${status})`,
    };
  }
  return { kind: "error", reason: "http", status, message: `HTTP ${status}` };
}
