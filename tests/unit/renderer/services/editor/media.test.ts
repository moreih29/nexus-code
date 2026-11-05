import { describe, expect, it } from "bun:test";
import {
  mediaDuration,
  mediaKindFor,
} from "../../../../../src/renderer/services/editor/preview/media";

describe("mediaKindFor", () => {
  it("tells audio from video by extension, case aside", () => {
    expect(mediaKindFor("/w/a/song.MP3")).toBe("audio");
    expect(mediaKindFor("/w/a/voice.m4a")).toBe("audio");
    expect(mediaKindFor("/w/a/clip.mp4")).toBe("video");
    expect(mediaKindFor("/w/a/screen.mov")).toBe("video");
    expect(mediaKindFor("/w/a/clip.webm")).toBe("video");
  });

  it("is null for other files", () => {
    expect(mediaKindFor("/w/a/notes.md")).toBeNull();
    expect(mediaKindFor("/w/a/mp4")).toBeNull();
  });
});

describe("mediaDuration", () => {
  it("shows minutes and seconds, and hours from an hour", () => {
    expect(mediaDuration(0)).toBe("0:00");
    expect(mediaDuration(83.7)).toBe("1:23");
    expect(mediaDuration(3600 + 5 * 60 + 9)).toBe("1:05:09");
  });
});
