import { describe, expect, test } from "bun:test";
import {
  changePending,
  fileSignal,
  isPlaying,
  keptSheet,
  mediaResume,
  nextShownVersion,
  pdfKept,
} from "../../../../../src/renderer/services/editor/preview/file-refresh";

describe("fileSignal", () => {
  test("another computer's file follows the remote generation", () => {
    expect(fileSignal(true, 3, 7)).toBe(7);
  });
  test("a local file follows the local watch", () => {
    expect(fileSignal(false, 3, 7)).toBe(3);
  });
});

describe("player hold while playing", () => {
  test("isPlaying: neither paused nor ended", () => {
    expect(isPlaying({ paused: false, ended: false })).toBe(true);
    expect(isPlaying({ paused: true, ended: false })).toBe(false);
    expect(isPlaying({ paused: false, ended: true })).toBe(false);
  });
  test("a change while playing is held", () => {
    expect(nextShownVersion(1, 2, true)).toBe(1);
    expect(changePending(1, 2)).toBe(true);
  });
  test("a change while stopped or ended loads at once", () => {
    expect(nextShownVersion(1, 2, false)).toBe(2);
    expect(changePending(2, 2)).toBe(false);
  });
  test("several changes while playing load the latest once it stops", () => {
    expect(nextShownVersion(1, 4, true)).toBe(1);
    expect(nextShownVersion(1, 4, false)).toBe(4);
  });
});

describe("mediaResume", () => {
  test("returns to the position, paused if it was", () => {
    expect(mediaResume(30, 120, false)).toEqual({ at: 30, play: false });
  });
  test("keeps playing if it was playing", () => {
    expect(mediaResume(30, 120, true)).toEqual({ at: 30, play: true });
  });
  test("starts over for a shorter file, an ended one, the start, or unknown length", () => {
    expect(mediaResume(30, 20, true)).toEqual({ at: null, play: false });
    expect(mediaResume(120, 120, false)).toEqual({ at: null, play: false });
    expect(mediaResume(0, 120, true)).toEqual({ at: null, play: false });
    expect(mediaResume(30, Number.POSITIVE_INFINITY, false)).toEqual({ at: null, play: false });
  });
});

describe("pdfKept", () => {
  test("the first document keeps nothing", () => {
    expect(pdfKept(false, false, "1.5", 10, 2)).toBeNull();
  });
  test("a reloaded one keeps zoom and scroll place", () => {
    expect(pdfKept(true, false, "1.5", 800, 4)).toEqual({ scale: "1.5", top: 800, left: 4 });
  });
  test("a fit still waiting for a width stays a fit", () => {
    expect(pdfKept(true, true, "0", 0, 0)).toEqual({ scale: "page-width", top: 0, left: 0 });
  });
});

describe("keptSheet", () => {
  const sheets = [{ name: "A" }, { name: "B" }];
  test("stays on the sheet shown", () => {
    expect(keptSheet(sheets, "B")).toBe(sheets[1]);
  });
  test("falls to the first when it is gone or none was chosen", () => {
    expect(keptSheet(sheets, "C")).toBe(sheets[0]);
    expect(keptSheet(sheets, null)).toBe(sheets[0]);
    expect(keptSheet([], "A")).toBeUndefined();
  });
});
