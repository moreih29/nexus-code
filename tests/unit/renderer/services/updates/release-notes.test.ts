import { describe, expect, it } from "bun:test";
import {
  newsVersionOf,
  releaseDate,
  releaseMark,
  shownNote,
} from "../../../../../src/renderer/services/updates/release-notes";
import type { ReleaseNote } from "../../../../../src/shared/updates/release-notes";

function note(version: string, prerelease = false): ReleaseNote {
  return {
    version,
    title: "",
    date: "2026-11-05T08:26:47Z",
    url: `https://example.invalid/releases/tag/v${version}`,
    html: "",
    prerelease,
  };
}

const NOTES = [note("1.2.0-beta.1", true), note("1.1.0"), note("1.0.0")];

describe("shownNote", () => {
  it("shows the release asked for, else the running one's, else the newest", () => {
    expect(shownNote(NOTES, "1.0.0", "1.1.0")?.version).toBe("1.0.0");
    expect(shownNote(NOTES, null, "1.1.0")?.version).toBe("1.1.0");
    expect(shownNote(NOTES, "0.9.0", "1.1.0")?.version).toBe("1.1.0");
    expect(shownNote(NOTES, null, "0.9.0")?.version).toBe("1.2.0-beta.1");
    expect(shownNote([], null, "1.1.0")).toBeNull();
  });
});

describe("releaseMark", () => {
  it("marks the running release, newer ones and prereleases", () => {
    expect(releaseMark(note("1.1.0"), "1.1.0")).toBe("current");
    expect(releaseMark(note("1.2.0"), "1.1.0")).toBe("newer");
    expect(releaseMark(note("1.2.0-beta.1", true), "1.1.0")).toBe("newer");
    expect(releaseMark(note("1.1.0-beta.1", true), "1.1.0")).toBe("prerelease");
    expect(releaseMark(note("1.0.0"), "1.1.0")).toBeNull();
  });
});

describe("newsVersionOf", () => {
  it("offers the running version's notes once an update brought it", () => {
    expect(newsVersionOf("1.0.0", "1.1.0")).toBe("1.1.0");
    expect(newsVersionOf("1.1.0", "1.1.0")).toBeNull();
    // Gone back to an older version: nothing new.
    expect(newsVersionOf("1.2.0", "1.1.0")).toBeNull();
  });

  it("offers nothing before anything was seen, or for a version it cannot read", () => {
    expect(newsVersionOf(null, "1.1.0")).toBeNull();
    expect(newsVersionOf("dev", "1.1.0")).toBeNull();
    expect(newsVersionOf("1.0.0", "dev")).toBeNull();
  });
});

describe("releaseDate", () => {
  it("words the date in the reader's language, and leaves out one it cannot read", () => {
    expect(releaseDate("2026-11-05T08:26:47Z", "en")).toBe("Nov 5, 2026");
    expect(releaseDate("not a date", "en")).toBe("");
  });
});
