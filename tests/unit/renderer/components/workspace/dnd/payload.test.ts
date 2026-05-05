/**
 * dnd/payload — DataTransfer parsing and MIME guard unit tests.
 *
 * parseDragPayload is the single point of truth for converting a raw
 * DataTransfer into a typed payload. Both group-level and tab-bar-level
 * drop targets call it, so it must:
 *   - return a typed `tab` discriminant when MIME_TAB carries valid JSON
 *   - return a typed `file` discriminant when MIME_FILE carries valid JSON
 *   - prefer MIME_TAB if both are populated (tab moves win over file opens)
 *   - return null on missing data or malformed JSON
 *
 * hasSupportedMime is the dragenter/dragover gate — MIME-only check that
 * runs before data is exposed (cross-window security).
 *
 * DOM note: bun:test has no jsdom; we hand-roll a minimal DataTransfer
 * stand-in that exposes only `getData(mime): string` and `types: string[]`,
 * which is all the parser uses.
 */
import { describe, expect, test } from "bun:test";
import {
  hasSupportedMime,
  parseDragPayload,
} from "../../../../../../src/renderer/components/workspace/dnd/payload";
import { MIME_FILE, MIME_TAB } from "../../../../../../src/renderer/components/workspace/dnd/types";

function fakeDt(record: Record<string, string>): DataTransfer {
  return {
    getData: (mime: string) => record[mime] ?? "",
    types: Object.keys(record),
  } as unknown as DataTransfer;
}

describe("parseDragPayload", () => {
  test("returns typed tab discriminant for valid TAB payload", () => {
    const payload = { workspaceId: "ws1", tabId: "t1", sourceGroupId: "g1" };
    const dt = fakeDt({ [MIME_TAB]: JSON.stringify(payload) });
    const result = parseDragPayload(dt);
    expect(result).toEqual({ kind: "tab", payload });
  });

  test("returns typed file discriminant for valid FILE payload", () => {
    const payload = { workspaceId: "ws1", filePath: "/a/b.ts" };
    const dt = fakeDt({ [MIME_FILE]: JSON.stringify(payload) });
    const result = parseDragPayload(dt);
    expect(result).toEqual({ kind: "file", payload });
  });

  test("prefers TAB over FILE when both are populated", () => {
    const tabPayload = { workspaceId: "ws1", tabId: "t1", sourceGroupId: "g1" };
    const filePayload = { workspaceId: "ws1", filePath: "/a/b.ts" };
    const dt = fakeDt({
      [MIME_TAB]: JSON.stringify(tabPayload),
      [MIME_FILE]: JSON.stringify(filePayload),
    });
    const result = parseDragPayload(dt);
    expect(result?.kind).toBe("tab");
  });

  test("returns null for empty DataTransfer", () => {
    const dt = fakeDt({});
    expect(parseDragPayload(dt)).toBeNull();
  });

  test("returns null on malformed TAB JSON", () => {
    const dt = fakeDt({ [MIME_TAB]: "not-json{" });
    expect(parseDragPayload(dt)).toBeNull();
  });

  test("returns null on malformed FILE JSON", () => {
    const dt = fakeDt({ [MIME_FILE]: "not-json{" });
    expect(parseDragPayload(dt)).toBeNull();
  });

  test("returns null when MIME slot has empty string (not present)", () => {
    // dataTransfer.getData returns "" for missing slots; the parser must
    // treat this as "absent" rather than parsing it as JSON.
    const dt = fakeDt({ [MIME_TAB]: "" });
    expect(parseDragPayload(dt)).toBeNull();
  });
});

describe("hasSupportedMime", () => {
  test("returns true when types contains MIME_TAB", () => {
    expect(hasSupportedMime([MIME_TAB])).toBe(true);
  });

  test("returns true when types contains MIME_FILE", () => {
    expect(hasSupportedMime([MIME_FILE])).toBe(true);
  });

  test("returns true when types contains both", () => {
    expect(hasSupportedMime([MIME_TAB, MIME_FILE])).toBe(true);
  });

  test("returns true alongside unrelated MIME types", () => {
    expect(hasSupportedMime(["text/plain", MIME_TAB, "Files"])).toBe(true);
  });

  test("returns false for unrelated MIME types only", () => {
    expect(hasSupportedMime(["text/plain", "text/html", "Files"])).toBe(false);
  });

  test("returns false for empty types", () => {
    expect(hasSupportedMime([])).toBe(false);
  });
});
