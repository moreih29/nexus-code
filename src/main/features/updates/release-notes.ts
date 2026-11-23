import { prerelease, rcompare, valid } from "semver";
import type { ReleaseNote, ReleaseNotesResult } from "../../../shared/updates/release-notes";
import { ResponseTooLargeError, readResponseText } from "../../infra/http/body";
import { REPO_BASE } from "./poller";

const FEED_URL = `${REPO_BASE}/releases.atom`;
const TIMEOUT_MS = 15_000;
const RELEASE_NOTES_MAX_BYTES = 1024 * 1024;

export interface ReleaseNotesCache {
  etag: string | null;
  notes: ReleaseNote[] | null;
}

export function createReleaseNotesCache(): ReleaseNotesCache {
  return { etag: null, notes: null };
}

export interface FetchReleaseNotesOptions {
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
      notes = parseReleaseNotes(await readResponseText(response, RELEASE_NOTES_MAX_BYTES));
      if (cache) {
        cache.etag = response.headers.get("etag");
        cache.notes = notes;
      }
    }
  } catch (error) {
    return {
      kind: "error",
      reason: error instanceof ResponseTooLargeError ? error.code : "network",
    };
  }
  return {
    kind: "ok",
    notes: channel === "stable" ? notes.filter((note) => !note.prerelease) : notes,
  };
}

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

function textOf(entry: string, name: string): string {
  const match = entry.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`));
  if (!match) return "";
  const text = match[1].trim();
  const cdata = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return cdata ? cdata[1] : text;
}

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

export function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (whole, ref: string) => {
    if (ref[0] !== "#") return NAMED[ref] ?? whole;
    const code =
      ref[1] === "x" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}
