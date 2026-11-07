/**
 * The recent releases' notes, read from the repository's Atom feed
 * (`releases.atom`), which lists the ten newest published releases with the
 * HTML GitHub renders from each one's Markdown. Like the poller, it reads
 * github.com rather than api.github.com, so it does not spend the API's
 * hourly allowance, and it keeps the feed's ETag so asking again while
 * nothing was published costs a 304.
 */

import { prerelease, rcompare, valid } from "semver";
import type { ReleaseNote, ReleaseNotesResult } from "../../../shared/updates/release-notes";
import { REPO_BASE } from "./poller";

const FEED_URL = `${REPO_BASE}/releases.atom`;
const TIMEOUT_MS = 15_000;

/** The last feed read, to ask GitHub whether it changed since. */
export interface ReleaseNotesCache {
  etag: string | null;
  notes: ReleaseNote[] | null;
}

export function createReleaseNotesCache(): ReleaseNotesCache {
  return { etag: null, notes: null };
}

export interface FetchReleaseNotesOptions {
  /** Stable leaves prereleases out. */
  channel: "stable" | "beta";
  fetchImpl?: typeof fetch;
  cache?: ReleaseNotesCache;
}

export async function fetchReleaseNotes(
  options: FetchReleaseNotesOptions,
): Promise<ReleaseNotesResult> {
  const { channel, fetchImpl = fetch, cache } = options;
  let notes: ReleaseNote[];
  try {
    const headers: Record<string, string> = { "User-Agent": "nexus-code-update-checker" };
    if (cache?.etag != null && cache.notes !== null) headers["If-None-Match"] = cache.etag;
    const response = await fetchImpl(FEED_URL, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 304 && cache?.notes != null) {
      notes = cache.notes;
    } else if (response.status === 403 || response.status === 429) {
      return { kind: "error", reason: "rate-limited" };
    } else if (!response.ok) {
      return { kind: "error", reason: "http" };
    } else {
      notes = parseReleaseNotes(await response.text());
      if (cache) {
        cache.etag = response.headers.get("etag");
        cache.notes = notes;
      }
    }
  } catch {
    return { kind: "error", reason: "network" };
  }
  return {
    kind: "ok",
    notes: channel === "stable" ? notes.filter((note) => !note.prerelease) : notes,
  };
}

/**
 * The releases in a GitHub releases feed, newest version first. An entry
 * whose link names no version is left out.
 */
export function parseReleaseNotes(feed: string): ReleaseNote[] {
  const notes: ReleaseNote[] = [];
  for (const [, entry] of feed.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const link = entry.match(/<link\b[^>]*\bhref="([^"]*\/releases\/tag\/[^"]*)"/)?.[1];
    if (!link) continue;
    const url = unescapeXml(link);
    const tag = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
    const version = tag.startsWith("v") ? tag.slice(1) : tag;
    if (!valid(version)) continue;
    notes.push({
      version,
      title: subtitleOf(unescapeXml(textOf(entry, "title")), tag, version),
      date: textOf(entry, "updated"),
      url,
      html: unescapeXml(textOf(entry, "content")),
      prerelease: prerelease(version) !== null,
    });
  }
  return notes.sort((a, b) => rcompare(a.version, b.version));
}

/** The text of an entry's first `name` element, as the feed has it. */
function textOf(entry: string, name: string): string {
  const match = entry.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`));
  if (!match) return "";
  const text = match[1].trim();
  const cdata = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return cdata ? cdata[1] : text;
}

/** A release's title without the version it starts with: "v1.2.0 — Sync" is "Sync". */
function subtitleOf(title: string, tag: string, version: string): string {
  for (const lead of [tag, `v${version}`, version]) {
    if (title.startsWith(lead)) {
      return title
        .slice(lead.length)
        .replace(/^\s*[—–:\-|·]?\s*/, "")
        .trim();
    }
  }
  return title.trim();
}

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** XML's five named entities and its character references, in one pass. */
export function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (whole, ref: string) => {
    if (ref[0] !== "#") return NAMED[ref] ?? whole;
    const code =
      ref[1] === "x" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}
