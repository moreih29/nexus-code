import { describe, expect, it } from "bun:test";
import {
  createReleaseNotesCache,
  fetchReleaseNotes,
  parseReleaseNotes,
  unescapeXml,
} from "../../../../../src/main/features/updates/release-notes";

const BASE = "https://github.com/moreih29/nexus-code/releases/tag";

function entry(tag: string, title: string, content: string, updated = "2026-11-05T08:26:47Z") {
  return `  <entry>
    <id>tag:github.com,2008:Repository/1/${tag}</id>
    <updated>${updated}</updated>
    <link rel="alternate" type="text/html" href="${BASE}/${tag}"/>
    <title>${title}</title>
    <content type="html">${content}</content>
    <author><name>someone</name></author>
  </entry>`;
}

function feed(...entries: string[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/moreih29/nexus-code/releases</id>
  <link type="text/html" rel="alternate" href="https://github.com/moreih29/nexus-code/releases"/>
  <title>Release notes from nexus-code</title>
  <updated>2026-11-05T08:12:46Z</updated>
${entries.join("\n")}
</feed>`;
}

const FEED = feed(
  entry("v0.9.0", "v0.9.0 — Diff editing", "&lt;p&gt;Older&lt;/p&gt;", "2026-10-01T00:00:00Z"),
  entry(
    "v0.10.0",
    "v0.10.0 — Updates &amp; more",
    "&lt;h3&gt;Added&lt;/h3&gt;\n&lt;ul&gt;\n&lt;li&gt;&lt;code&gt;a &amp;amp; b&lt;/code&gt; &amp;quot;q&amp;quot;&lt;/li&gt;\n&lt;/ul&gt;",
    "2026-10-10T00:00:00Z",
  ),
  entry("v0.11.0-beta.1", "v0.11.0-beta.1", "&lt;p&gt;Beta&lt;/p&gt;", "2026-10-20T00:00:00Z"),
  entry("nightly", "Nightly", "&lt;p&gt;Not a version&lt;/p&gt;"),
);

describe("parseReleaseNotes", () => {
  it("reads each release with a version, newest version first", () => {
    const notes = parseReleaseNotes(FEED);
    expect(notes.map((n) => n.version)).toEqual(["0.11.0-beta.1", "0.10.0", "0.9.0"]);
    expect(notes[1]).toEqual({
      version: "0.10.0",
      title: "Updates & more",
      date: "2026-10-10T00:00:00Z",
      url: `${BASE}/v0.10.0`,
      html: "<h3>Added</h3>\n<ul>\n<li><code>a &amp; b</code> &quot;q&quot;</li>\n</ul>",
      prerelease: false,
    });
    expect(notes[0]).toMatchObject({ title: "", prerelease: true });
  });

  it("keeps a title that does not start with the version", () => {
    const notes = parseReleaseNotes(feed(entry("v1.0.0", "First stable", "")));
    expect(notes[0]?.title).toBe("First stable");
  });

  it("reads nothing from a feed without releases", () => {
    expect(parseReleaseNotes(feed())).toEqual([]);
    expect(parseReleaseNotes("not a feed")).toEqual([]);
  });
});

describe("unescapeXml", () => {
  it("unescapes the named entities and character references once", () => {
    expect(unescapeXml("&lt;b&gt; &amp;lt; &#39; &#x2014; &apos;&quot;")).toBe("<b> &lt; ' — '\"");
    expect(unescapeXml("&nbsp; &#x110000;")).toBe("&nbsp; &#x110000;");
  });
});

function respond(status: number, body = "", etag?: string): Response {
  return new Response(status === 304 ? null : body, {
    status,
    headers: etag ? { etag } : {},
  });
}

describe("fetchReleaseNotes", () => {
  it("leaves prereleases out on the stable channel", async () => {
    const fetchImpl = (async () => respond(200, FEED)) as unknown as typeof fetch;
    const stable = await fetchReleaseNotes({ channel: "stable", fetchImpl });
    const beta = await fetchReleaseNotes({ channel: "beta", fetchImpl });
    expect(stable.kind === "ok" && stable.notes.map((n) => n.version)).toEqual(["0.10.0", "0.9.0"]);
    expect(beta.kind === "ok" && beta.notes.length).toBe(3);
  });

  it("asks with the last ETag and keeps the notes on 304", async () => {
    const asked: Array<string | undefined> = [];
    let status = 200;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      asked.push((init?.headers as Record<string, string>)["If-None-Match"]);
      return respond(status, FEED, '"abc"');
    }) as unknown as typeof fetch;
    const cache = createReleaseNotesCache();
    const first = await fetchReleaseNotes({ channel: "beta", fetchImpl, cache });
    status = 304;
    const second = await fetchReleaseNotes({ channel: "beta", fetchImpl, cache });
    expect(asked).toEqual([undefined, '"abc"']);
    expect(second).toEqual(first);
  });

  it("tells why the notes could not be read", async () => {
    const answer = (status: number) => (async () => respond(status)) as unknown as typeof fetch;
    expect(await fetchReleaseNotes({ channel: "stable", fetchImpl: answer(403) })).toEqual({
      kind: "error",
      reason: "rate-limited",
    });
    expect(await fetchReleaseNotes({ channel: "stable", fetchImpl: answer(500) })).toEqual({
      kind: "error",
      reason: "http",
    });
    // A 304 with nothing kept is no answer.
    expect(await fetchReleaseNotes({ channel: "stable", fetchImpl: answer(304) })).toEqual({
      kind: "error",
      reason: "http",
    });
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await fetchReleaseNotes({ channel: "stable", fetchImpl: offline })).toEqual({
      kind: "error",
      reason: "network",
    });
  });
});
