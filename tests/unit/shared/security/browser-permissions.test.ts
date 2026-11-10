/**
 * Unit tests for the browser permission taxonomy module.
 *
 * Covers:
 * - classifyPermission: all 20 known kinds + unknown string inputs
 * - isKnownPermission: union membership excluding 'unknown'
 * - PERMISSION_TOGGLES: structural assertions (no auto/unknown entries)
 */

import { describe, expect, test } from "bun:test";
import {
  PERMISSION_TOGGLES,
  classifyPermission,
  isKnownPermission,
} from "../../../../src/shared/security/browser-permissions";

// ---------------------------------------------------------------------------
// classifyPermission
// ---------------------------------------------------------------------------

describe("classifyPermission", () => {
  // --- auto ---
  test("clipboard-sanitized-write → auto", () => {
    expect(classifyPermission("clipboard-sanitized-write")).toBe("auto");
  });

  test("storage-access → auto", () => {
    expect(classifyPermission("storage-access")).toBe("auto");
  });

  test("top-level-storage-access → auto", () => {
    expect(classifyPermission("top-level-storage-access")).toBe("auto");
  });

  // --- blocked ---
  test("'unknown' → blocked", () => {
    expect(classifyPermission("unknown")).toBe("blocked");
  });

  test("unrecognised string → blocked", () => {
    expect(classifyPermission("super-power")).toBe("blocked");
  });

  test("empty string → blocked", () => {
    expect(classifyPermission("")).toBe("blocked");
  });

  test("near-miss typo → blocked", () => {
    // 'media' is known but 'medias' is not
    expect(classifyPermission("medias")).toBe("blocked");
  });

  // --- prompt (all remaining known kinds) ---
  const promptPermissions = [
    "clipboard-read",
    "display-capture",
    "fullscreen",
    "geolocation",
    "idle-detection",
    "media",
    "mediaKeySystem",
    "midi",
    "midiSysex",
    "notifications",
    "pointerLock",
    "keyboardLock",
    "openExternal",
    "speaker-selection",
    "window-management",
    "fileSystem",
  ] as const;

  for (const p of promptPermissions) {
    test(`${p} → prompt`, () => {
      expect(classifyPermission(p)).toBe("prompt");
    });
  }
});

// ---------------------------------------------------------------------------
// isKnownPermission
// ---------------------------------------------------------------------------

describe("isKnownPermission", () => {
  test("known permission other than 'unknown' → true", () => {
    expect(isKnownPermission("media")).toBe(true);
    expect(isKnownPermission("geolocation")).toBe(true);
    expect(isKnownPermission("clipboard-read")).toBe(true);
    expect(isKnownPermission("fileSystem")).toBe(true);
  });

  test("'unknown' → false (first-class blocked kind)", () => {
    expect(isKnownPermission("unknown")).toBe(false);
  });

  test("unrecognised string → false", () => {
    expect(isKnownPermission("super-power")).toBe(false);
    expect(isKnownPermission("")).toBe(false);
  });

  test("auto-granted permissions are still known → true", () => {
    expect(isKnownPermission("clipboard-sanitized-write")).toBe(true);
    expect(isKnownPermission("storage-access")).toBe(true);
    expect(isKnownPermission("top-level-storage-access")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PERMISSION_TOGGLES structure
// ---------------------------------------------------------------------------

describe("PERMISSION_TOGGLES", () => {
  test("no toggle covers auto-granted permissions", () => {
    const autoPermissions = new Set([
      "clipboard-sanitized-write",
      "storage-access",
      "top-level-storage-access",
    ]);
    for (const toggle of PERMISSION_TOGGLES) {
      for (const p of toggle.permissions) {
        expect(autoPermissions.has(p)).toBe(false);
      }
    }
  });

  test("no toggle covers 'unknown'", () => {
    for (const toggle of PERMISSION_TOGGLES) {
      expect(toggle.permissions).not.toContain("unknown");
    }
  });
});
