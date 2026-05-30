/**
 * Unit tests for the browser permission taxonomy module.
 *
 * Covers:
 * - classifyPermission: all 20 known kinds + unknown string inputs
 * - isKnownPermission: union membership excluding 'unknown'
 * - PERMISSION_TOGGLES: structural assertions (tier counts, no auto/unknown entries)
 * - permissionLabel: spot-check label lookups
 */

import { describe, expect, test } from "bun:test";
import {
  BrowserPermissionKindSchema,
  PERMISSION_TOGGLES,
  classifyPermission,
  isKnownPermission,
  permissionLabel,
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

  // Exhaustiveness check: every enum member is classified (no missing case).
  test("every BrowserPermissionKind maps to a classification", () => {
    const allKinds = BrowserPermissionKindSchema.options;
    for (const kind of allKinds) {
      const result = classifyPermission(kind);
      expect(["auto", "blocked", "prompt"]).toContain(result);
    }
  });
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
  test("contains exactly 14 entries (7 Tier A + 7 Tier B)", () => {
    expect(PERMISSION_TOGGLES).toHaveLength(14);
  });

  test("has 7 Tier A entries", () => {
    const tierA = PERMISSION_TOGGLES.filter((t) => t.tier === "A");
    expect(tierA).toHaveLength(7);
  });

  test("has 7 Tier B entries", () => {
    const tierB = PERMISSION_TOGGLES.filter((t) => t.tier === "B");
    expect(tierB).toHaveLength(7);
  });

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

  test("every toggle has a non-empty key, label, description, and icon", () => {
    for (const toggle of PERMISSION_TOGGLES) {
      expect(toggle.key.length).toBeGreaterThan(0);
      expect(toggle.label.length).toBeGreaterThan(0);
      expect(toggle.description.length).toBeGreaterThan(0);
      expect(toggle.icon.length).toBeGreaterThan(0);
    }
  });

  test("every toggle permission is a valid BrowserPermissionKind", () => {
    for (const toggle of PERMISSION_TOGGLES) {
      for (const p of toggle.permissions) {
        expect(BrowserPermissionKindSchema.safeParse(p).success).toBe(true);
      }
    }
  });

  test("merged groups have multiple permissions", () => {
    const midi = PERMISSION_TOGGLES.find((t) => t.key === "midi+midiSysex");
    expect(midi?.permissions).toEqual(["midi", "midiSysex"]);

    const inputLock = PERMISSION_TOGGLES.find((t) => t.key === "pointerLock+keyboardLock");
    expect(inputLock?.permissions).toEqual(["pointerLock", "keyboardLock"]);
  });

  test("Tier A entries come before Tier B entries (ordering)", () => {
    let seenB = false;
    for (const toggle of PERMISSION_TOGGLES) {
      if (toggle.tier === "B") seenB = true;
      if (seenB) {
        // Once we've seen a B, we must not see an A
        expect(toggle.tier).toBe("B");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// permissionLabel
// ---------------------------------------------------------------------------

describe("permissionLabel", () => {
  // permissionLabel() is the shared, non-localized English fallback helper.
  // Localized (e.g. Korean) labels are resolved in the UI layer via i18n
  // `t("browserPermissions.permissionLabel.*")`, not by this function.
  test("media → 'Camera & microphone'", () => {
    expect(permissionLabel("media")).toBe("Camera & microphone");
  });

  test("midi → 'MIDI'", () => {
    expect(permissionLabel("midi")).toBe("MIDI");
  });

  test("geolocation → 'Location'", () => {
    expect(permissionLabel("geolocation")).toBe("Location");
  });

  test("unknown → 'Unknown permission'", () => {
    expect(permissionLabel("unknown")).toBe("Unknown permission");
  });

  test("every BrowserPermissionKind has a label (no undefined)", () => {
    const allKinds = BrowserPermissionKindSchema.options;
    for (const kind of allKinds) {
      const label = permissionLabel(kind);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
