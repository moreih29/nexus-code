/**
 * Browser permission taxonomy for the embedded browser view.
 *
 * WHY SHARED MODULE
 * The main process uses `setPermissionRequestHandler` to allow/deny permission
 * requests, while the renderer shows per-permission toggles and a request
 * modal.  Both need the same classification and label data.  Keeping this as
 * a single source of truth prevents the two sides from diverging silently.
 *
 * WHY NO ELECTRON IMPORT
 * This file is imported by the renderer process as well as the main process.
 * Importing from 'electron' in a shared module couples the renderer bundle to
 * the main-process API surface, which causes webpack/Vite to bundle Node-only
 * symbols into the renderer.  All Electron-specific types are replicated here
 * as plain strings.
 *
 * PERMISSION UNION SOURCE
 * The 20-member union matches the set documented for Electron's
 * `setPermissionRequestHandler` callback (as of Electron 30.x).  The
 * 'unknown' member is included because Electron passes it when it cannot
 * classify the underlying Chromium request.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Permission kind schema & type
// ---------------------------------------------------------------------------

/**
 * All permission strings that Electron's `setPermissionRequestHandler`
 * callback may pass as the `permission` argument.
 *
 * The value 'unknown' is a first-class member: Electron uses it when
 * Chromium issues a permission request that Electron does not recognise.
 */
export const BrowserPermissionKindSchema = z.enum([
  "clipboard-read",
  "clipboard-sanitized-write",
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
  "storage-access",
  "top-level-storage-access",
  "window-management",
  "unknown",
  "fileSystem",
]);

export type BrowserPermissionKind = z.infer<typeof BrowserPermissionKindSchema>;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Permissions that are automatically granted — no prompt, no user toggle. */
const AUTO_PERMISSIONS = new Set<BrowserPermissionKind>([
  "clipboard-sanitized-write",
  "storage-access",
  "top-level-storage-access",
]);

/**
 * Classifies an arbitrary permission string into one of three buckets.
 *
 * - `'auto'`    — grant silently (low-risk, expected on any site)
 * - `'blocked'` — deny unconditionally ('unknown' or unrecognised string)
 * - `'prompt'`  — surface to the user via modal / toggle
 *
 * Any string outside the known 20-member union is treated as `'blocked'`
 * because unknown permission strings represent requests whose semantics
 * cannot be audited.
 */
export function classifyPermission(permission: string): "blocked" | "auto" | "prompt" {
  const parsed = BrowserPermissionKindSchema.safeParse(permission);

  if (!parsed.success) {
    // String is not a member of the known union at all.
    return "blocked";
  }

  const kind = parsed.data;

  if (kind === "unknown") {
    return "blocked";
  }

  if (AUTO_PERMISSIONS.has(kind)) {
    return "auto";
  }

  return "prompt";
}

/**
 * Returns true when `permission` is a recognised permission kind other than
 * 'unknown'.
 *
 * The main-process resolver uses this to distinguish known-but-blocked
 * (e.g. 'unknown') from truly unrecognised strings, which both resolve to
 * deny but may warrant different log levels.
 */
export function isKnownPermission(permission: string): boolean {
  const parsed = BrowserPermissionKindSchema.safeParse(permission);
  if (!parsed.success) return false;
  return parsed.data !== "unknown";
}

// ---------------------------------------------------------------------------
// Toggle metadata
// ---------------------------------------------------------------------------

/**
 * Metadata for a single user-facing permission toggle.
 *
 * A toggle may cover one permission (key === permissions[0]) or a merged
 * group of closely related permissions (e.g. midi + midiSysex).
 */
export interface PermissionToggle {
  /** Stable identifier for the toggle — either a BrowserPermissionKind or a
   * synthetic group id (e.g. 'midi+midiSysex', 'pointerLock+keyboardLock'). */
  key: string;
  /** The actual BrowserPermissionKind values this toggle controls. */
  permissions: BrowserPermissionKind[];
  /** Display priority tier: A = most commonly needed, B = advanced/rare. */
  tier: "A" | "B";
  /** Short human-readable label shown next to the toggle. */
  label: string;
  /** One-sentence description in "This site …" tone. */
  description: string;
  /** Lucide icon name (string only — renderer maps name to component). */
  icon: string;
}

/**
 * Ordered list of permission toggles shown in the browser permission settings
 * panel and the per-site permission modal.
 *
 * Tier A entries come first, then Tier B.  Automatically-granted permissions
 * (clipboard-sanitized-write, storage-access, top-level-storage-access) and
 * 'unknown' are intentionally absent — they are never surfaced to the user.
 */
export const PERMISSION_TOGGLES: PermissionToggle[] = [
  // -------------------------------------------------------------------------
  // Tier A — most commonly requested
  // -------------------------------------------------------------------------
  {
    key: "media",
    permissions: ["media"],
    tier: "A",
    label: "Camera & microphone",
    description: "This site can access your camera and microphone.",
    icon: "Video",
  },
  {
    key: "geolocation",
    permissions: ["geolocation"],
    tier: "A",
    label: "Location",
    description: "This site can request your current location.",
    icon: "MapPin",
  },
  {
    key: "notifications",
    permissions: ["notifications"],
    tier: "A",
    label: "Notifications",
    description: "This site can send you notifications.",
    icon: "Bell",
  },
  {
    key: "display-capture",
    permissions: ["display-capture"],
    tier: "A",
    label: "Screen sharing",
    description: "This site can capture your screen or a window.",
    icon: "MonitorUp",
  },
  {
    key: "clipboard-read",
    permissions: ["clipboard-read"],
    tier: "A",
    label: "Clipboard read",
    description: "This site can read content copied to your clipboard.",
    icon: "Clipboard",
  },
  {
    key: "openExternal",
    permissions: ["openExternal"],
    tier: "A",
    label: "Open external apps",
    description: "This site can launch external applications.",
    icon: "ExternalLink",
  },
  {
    key: "fileSystem",
    permissions: ["fileSystem"],
    tier: "A",
    label: "File access",
    description: "This site can access your local file system.",
    icon: "FolderOpen",
  },

  // -------------------------------------------------------------------------
  // Tier B — advanced or rarely needed
  // -------------------------------------------------------------------------
  {
    key: "midi+midiSysex",
    permissions: ["midi", "midiSysex"],
    tier: "B",
    label: "MIDI devices",
    description: "This site can connect to your MIDI devices.",
    icon: "Music",
  },
  {
    key: "fullscreen",
    permissions: ["fullscreen"],
    tier: "B",
    label: "Fullscreen",
    description: "This site can enter fullscreen mode.",
    icon: "Maximize",
  },
  {
    key: "pointerLock+keyboardLock",
    permissions: ["pointerLock", "keyboardLock"],
    tier: "B",
    label: "Input lock",
    description: "This site can capture your mouse pointer and keyboard input.",
    icon: "Lock",
  },
  {
    key: "idle-detection",
    permissions: ["idle-detection"],
    tier: "B",
    label: "Idle detection",
    description: "This site can detect when you are active or idle.",
    icon: "Clock",
  },
  {
    key: "window-management",
    permissions: ["window-management"],
    tier: "B",
    label: "Window placement",
    description: "This site can control window position and size.",
    icon: "LayoutGrid",
  },
  {
    key: "speaker-selection",
    permissions: ["speaker-selection"],
    tier: "B",
    label: "Speaker selection",
    description: "This site can choose your audio output device.",
    icon: "Volume2",
  },
  {
    key: "mediaKeySystem",
    permissions: ["mediaKeySystem"],
    tier: "B",
    label: "Protected content (DRM)",
    description: "This site can play DRM-protected media.",
    icon: "ShieldCheck",
  },
];

// ---------------------------------------------------------------------------
// Per-permission label map (modal use)
// ---------------------------------------------------------------------------

/** Human-readable labels for individual BrowserPermissionKind values.
 *
 * Used by the permission request modal to describe the specific permission
 * being asked for.  Callers that need to split 'media' into camera vs.
 * microphone must inspect the MediaStreamConstraints passed alongside the
 * permission request — this map provides only the coarse-grained label.
 */
const PERMISSION_LABEL_MAP: Record<BrowserPermissionKind, string> = {
  "clipboard-read": "Clipboard read",
  "clipboard-sanitized-write": "Clipboard write",
  "display-capture": "Screen sharing",
  fullscreen: "Fullscreen",
  geolocation: "Location",
  "idle-detection": "Idle detection",
  media: "Camera & microphone",
  mediaKeySystem: "Protected content (DRM)",
  midi: "MIDI",
  midiSysex: "MIDI SysEx",
  notifications: "Notifications",
  pointerLock: "Pointer lock",
  keyboardLock: "Keyboard lock",
  openExternal: "Open external apps",
  "speaker-selection": "Speaker selection",
  "storage-access": "Storage access",
  "top-level-storage-access": "Top-level storage access",
  "window-management": "Window placement",
  unknown: "Unknown permission",
  fileSystem: "File access",
};

/**
 * Returns the human-readable label for a given BrowserPermissionKind.
 *
 * Always returns a string — falls back to the raw permission key if the map
 * is somehow missing an entry (defensive for forward-compatibility).
 */
export function permissionLabel(permission: BrowserPermissionKind): string {
  return PERMISSION_LABEL_MAP[permission] ?? permission;
}
