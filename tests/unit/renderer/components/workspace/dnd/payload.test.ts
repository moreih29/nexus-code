/**
 * dnd/payload — DataTransfer parsing and MIME guard unit tests.
 *
 * Phase E: adds tests for `buildFileDragPayload`, `parseFileDragPayload`,
 * and updates `parseDragPayload` tests to use the new `filePaths` shape.
 */
import { describe, expect, it, test } from "bun:test";
import {
  buildFileDragPayload,
  hasSupportedMime,
  parseDragPayload,
  parseFileDragPayload,
} from "../../../../../../src/renderer/components/workspace/dnd/payload";
import { MIME_FILE, MIME_TAB } from "../../../../../../src/renderer/components/workspace/dnd/types";

function fakeDt(record: Record<string, string>): DataTransfer {
  return {
    getData: (mime: string) => record[mime] ?? "",
    types: Object.keys(record),
  } as unknown as DataTransfer;
}

// ---------------------------------------------------------------------------
// buildFileDragPayload
// ---------------------------------------------------------------------------

describe("buildFileDragPayload", () => {
  it("returns a FileDragPayload with the given wsId and paths", () => {
    const p = buildFileDragPayload("ws1", ["/a/b.ts"]);
    expect(p.workspaceId).toBe("ws1");
    expect(p.filePaths).toEqual(["/a/b.ts"]);
  });

  it("preserves multiple paths", () => {
    const p = buildFileDragPayload("ws1", ["/a/b.ts", "/a/c.ts"]);
    expect(p.filePaths).toHaveLength(2);
  });

  it("throws when filePaths is empty", () => {
    expect(() => buildFileDragPayload("ws1", [])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseFileDragPayload
// ---------------------------------------------------------------------------

describe("parseFileDragPayload", () => {
  it("returns payload for valid filePaths shape", () => {
    const raw = JSON.stringify({ workspaceId: "ws1", filePaths: ["/a/b.ts"] });
    const dt = fakeDt({ [MIME_FILE]: raw });
    const result = parseFileDragPayload(dt);
    expect(result).not.toBeNull();
    expect(result?.workspaceId).toBe("ws1");
    expect(result?.filePaths).toEqual(["/a/b.ts"]);
  });

  it("returns payload for multi-path array", () => {
    const raw = JSON.stringify({ workspaceId: "ws1", filePaths: ["/a/b.ts", "/a/c.ts"] });
    const dt = fakeDt({ [MIME_FILE]: raw });
    const result = parseFileDragPayload(dt);
    expect(result?.filePaths).toHaveLength(2);
  });

  it("returns null when MIME_FILE is absent", () => {
    const dt = fakeDt({});
    expect(parseFileDragPayload(dt)).toBeNull();
  });

  it("returns null when MIME_FILE is empty string", () => {
    const dt = fakeDt({ [MIME_FILE]: "" });
    expect(parseFileDragPayload(dt)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const dt = fakeDt({ [MIME_FILE]: "not-json{" });
    expect(parseFileDragPayload(dt)).toBeNull();
  });

  it("returns null when workspaceId is missing", () => {
    const raw = JSON.stringify({ filePaths: ["/a/b.ts"] });
    const dt = fakeDt({ [MIME_FILE]: raw });
    expect(parseFileDragPayload(dt)).toBeNull();
  });

  it("returns null when filePaths is empty array", () => {
    const raw = JSON.stringify({ workspaceId: "ws1", filePaths: [] });
    const dt = fakeDt({ [MIME_FILE]: raw });
    expect(parseFileDragPayload(dt)).toBeNull();
  });

  it("returns null when filePaths contains non-string entry", () => {
    const raw = JSON.stringify({ workspaceId: "ws1", filePaths: ["/a/b.ts", 42] });
    const dt = fakeDt({ [MIME_FILE]: raw });
    expect(parseFileDragPayload(dt)).toBeNull();
  });

  it("returns null when filePaths field is absent (old filePath shape)", () => {
    // Old single-path payload without filePaths should be rejected.
    const raw = JSON.stringify({ workspaceId: "ws1", filePath: "/a/b.ts" });
    const dt = fakeDt({ [MIME_FILE]: raw });
    expect(parseFileDragPayload(dt)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseDragPayload (union — updated to use filePaths)
// ---------------------------------------------------------------------------

describe("parseDragPayload", () => {
  test("returns typed tab discriminant for valid TAB payload", () => {
    const payload = { workspaceId: "ws1", tabId: "t1", sourceGroupId: "g1" };
    const dt = fakeDt({ [MIME_TAB]: JSON.stringify(payload) });
    const result = parseDragPayload(dt);
    expect(result).toEqual({ kind: "tab", payload });
  });

  test("returns typed file discriminant for valid FILE payload (filePaths)", () => {
    const payload = { workspaceId: "ws1", filePaths: ["/a/b.ts"] };
    const dt = fakeDt({ [MIME_FILE]: JSON.stringify(payload) });
    const result = parseDragPayload(dt);
    expect(result).toEqual({ kind: "file", payload });
  });

  test("prefers TAB over FILE when both are populated", () => {
    const tabPayload = { workspaceId: "ws1", tabId: "t1", sourceGroupId: "g1" };
    const filePayload = { workspaceId: "ws1", filePaths: ["/a/b.ts"] };
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
    const dt = fakeDt({ [MIME_TAB]: "" });
    expect(parseDragPayload(dt)).toBeNull();
  });

  test("returns null for old filePath shape (not filePaths)", () => {
    const dt = fakeDt({
      [MIME_FILE]: JSON.stringify({ workspaceId: "ws1", filePath: "/a/b.ts" }),
    });
    expect(parseDragPayload(dt)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hasSupportedMime (unchanged)
// ---------------------------------------------------------------------------

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
