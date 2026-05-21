/**
 * workspace-row-drag — payload parsing and MIME guard unit tests.
 *
 * parseWorkspaceDragPayload is the only channel for reading workspace-row
 * drag data from a DataTransfer. It must:
 *   - return a typed payload for valid JSON with the required fields
 *   - return null when the MIME slot is absent or empty
 *   - return null on malformed JSON
 *   - return null when required fields are missing or have wrong types
 *
 * hasWorkspaceRowMime is the dragenter/dragover gate — inspects types array
 * before data is accessible.
 *
 * DOM note: bun:test has no jsdom; a minimal DataTransfer stub is used.
 */

import { describe, expect, test } from "bun:test";
import {
  hasWorkspaceRowMime,
  MIME_WORKSPACE_ROW,
  parseWorkspaceDragPayload,
} from "../../../../../../src/renderer/components/workbench/dnd/workspace-row-drag";

/** Minimal DataTransfer stub — only getData and types are used by the parser. */
function fakeDt(record: Record<string, string>): DataTransfer {
  return {
    getData: (mime: string) => record[mime] ?? "",
    types: Object.keys(record),
  } as unknown as DataTransfer;
}

describe("parseWorkspaceDragPayload", () => {
  test("returns typed payload for valid JSON", () => {
    const payload = { workspaceId: "abc-123", pinned: false };
    const dt = fakeDt({ [MIME_WORKSPACE_ROW]: JSON.stringify(payload) });
    expect(parseWorkspaceDragPayload(dt)).toEqual(payload);
  });

  test("returns typed payload when pinned=true", () => {
    const payload = { workspaceId: "abc-123", pinned: true };
    const dt = fakeDt({ [MIME_WORKSPACE_ROW]: JSON.stringify(payload) });
    expect(parseWorkspaceDragPayload(dt)).toEqual(payload);
  });

  test("returns null when MIME slot is absent", () => {
    const dt = fakeDt({});
    expect(parseWorkspaceDragPayload(dt)).toBeNull();
  });

  test("returns null when MIME slot is empty string", () => {
    const dt = fakeDt({ [MIME_WORKSPACE_ROW]: "" });
    expect(parseWorkspaceDragPayload(dt)).toBeNull();
  });

  test("returns null on malformed JSON", () => {
    const dt = fakeDt({ [MIME_WORKSPACE_ROW]: "{not-json" });
    expect(parseWorkspaceDragPayload(dt)).toBeNull();
  });

  test("returns null when workspaceId field is missing", () => {
    const dt = fakeDt({ [MIME_WORKSPACE_ROW]: JSON.stringify({ pinned: false }) });
    expect(parseWorkspaceDragPayload(dt)).toBeNull();
  });

  test("returns null when pinned field is missing", () => {
    const dt = fakeDt({ [MIME_WORKSPACE_ROW]: JSON.stringify({ workspaceId: "abc-123" }) });
    expect(parseWorkspaceDragPayload(dt)).toBeNull();
  });

  test("returns null when workspaceId is not a string", () => {
    const dt = fakeDt({ [MIME_WORKSPACE_ROW]: JSON.stringify({ workspaceId: 42, pinned: false }) });
    expect(parseWorkspaceDragPayload(dt)).toBeNull();
  });

  test("returns null when pinned is not a boolean", () => {
    const dt = fakeDt({
      [MIME_WORKSPACE_ROW]: JSON.stringify({ workspaceId: "abc-123", pinned: "yes" }),
    });
    expect(parseWorkspaceDragPayload(dt)).toBeNull();
  });

  test("returns null for a non-object JSON value (string)", () => {
    const dt = fakeDt({ [MIME_WORKSPACE_ROW]: JSON.stringify("string-value") });
    expect(parseWorkspaceDragPayload(dt)).toBeNull();
  });
});

describe("hasWorkspaceRowMime", () => {
  test("returns true when types contains the workspace-row MIME", () => {
    expect(hasWorkspaceRowMime([MIME_WORKSPACE_ROW])).toBe(true);
  });

  test("returns true alongside other MIME types", () => {
    expect(hasWorkspaceRowMime(["text/plain", MIME_WORKSPACE_ROW])).toBe(true);
  });

  test("returns false for unrelated types", () => {
    expect(hasWorkspaceRowMime(["text/plain", "application/x-nexus-tab"])).toBe(false);
  });

  test("returns false for empty types", () => {
    expect(hasWorkspaceRowMime([])).toBe(false);
  });
});
