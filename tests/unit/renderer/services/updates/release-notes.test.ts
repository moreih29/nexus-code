import { describe, expect, it } from "bun:test";
import {
  newsVersionOf,
  releaseMark,
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
