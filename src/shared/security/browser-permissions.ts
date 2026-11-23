import { z } from "zod";

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

const AUTO_PERMISSIONS = new Set<BrowserPermissionKind>([
  "clipboard-sanitized-write",
  "storage-access",
  "top-level-storage-access",
]);

export function classifyPermission(permission: string): "blocked" | "auto" | "prompt" {
  const parsed = BrowserPermissionKindSchema.safeParse(permission);

  if (!parsed.success) {
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

export function isKnownPermission(permission: string): boolean {
  const parsed = BrowserPermissionKindSchema.safeParse(permission);
  if (!parsed.success) return false;
  return parsed.data !== "unknown";
}

export interface PermissionToggle {
  key: string;
  permissions: BrowserPermissionKind[];
  tier: "A" | "B";
  label: string;
  description: string;
  icon: string;
}

export const PERMISSION_TOGGLES: PermissionToggle[] = [
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

export function permissionLabel(permission: BrowserPermissionKind): string {
  return PERMISSION_LABEL_MAP[permission] ?? permission;
}
