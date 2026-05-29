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
  /** Short human-readable label shown next to the toggle (Korean). */
  label: string;
  /** One-sentence description with '사이트가 ~합니다' tone (Korean). */
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
    label: "카메라 및 마이크",
    description: "사이트가 카메라와 마이크에 접근합니다.",
    icon: "Video",
  },
  {
    key: "geolocation",
    permissions: ["geolocation"],
    tier: "A",
    label: "위치",
    description: "사이트가 현재 위치 정보를 요청합니다.",
    icon: "MapPin",
  },
  {
    key: "notifications",
    permissions: ["notifications"],
    tier: "A",
    label: "알림",
    description: "사이트가 알림을 보냅니다.",
    icon: "Bell",
  },
  {
    key: "display-capture",
    permissions: ["display-capture"],
    tier: "A",
    label: "화면 공유",
    description: "사이트가 화면 또는 창을 캡처합니다.",
    icon: "MonitorUp",
  },
  {
    key: "clipboard-read",
    permissions: ["clipboard-read"],
    tier: "A",
    label: "클립보드 읽기",
    description: "사이트가 클립보드에 복사된 내용을 읽습니다.",
    icon: "Clipboard",
  },
  {
    key: "openExternal",
    permissions: ["openExternal"],
    tier: "A",
    label: "외부 앱 열기",
    description: "사이트가 외부 애플리케이션을 실행합니다.",
    icon: "ExternalLink",
  },
  {
    key: "fileSystem",
    permissions: ["fileSystem"],
    tier: "A",
    label: "파일 접근",
    description: "사이트가 로컬 파일 시스템에 접근합니다.",
    icon: "FolderOpen",
  },

  // -------------------------------------------------------------------------
  // Tier B — advanced or rarely needed
  // -------------------------------------------------------------------------
  {
    key: "midi+midiSysex",
    permissions: ["midi", "midiSysex"],
    tier: "B",
    label: "MIDI 기기",
    description: "사이트가 MIDI 기기에 연결합니다.",
    icon: "Music",
  },
  {
    key: "fullscreen",
    permissions: ["fullscreen"],
    tier: "B",
    label: "전체 화면",
    description: "사이트가 전체 화면 모드를 요청합니다.",
    icon: "Maximize",
  },
  {
    key: "pointerLock+keyboardLock",
    permissions: ["pointerLock", "keyboardLock"],
    tier: "B",
    label: "입력 잠금",
    description: "사이트가 마우스 포인터와 키보드 입력을 독점합니다.",
    icon: "Lock",
  },
  {
    key: "idle-detection",
    permissions: ["idle-detection"],
    tier: "B",
    label: "사용 여부 감지",
    description: "사이트가 사용자의 활동 여부를 감지합니다.",
    icon: "Clock",
  },
  {
    key: "window-management",
    permissions: ["window-management"],
    tier: "B",
    label: "창 배치",
    description: "사이트가 창의 위치와 크기를 제어합니다.",
    icon: "LayoutGrid",
  },
  {
    key: "speaker-selection",
    permissions: ["speaker-selection"],
    tier: "B",
    label: "스피커 선택",
    description: "사이트가 출력 오디오 장치를 선택합니다.",
    icon: "Volume2",
  },
  {
    key: "mediaKeySystem",
    permissions: ["mediaKeySystem"],
    tier: "B",
    label: "보호된 콘텐츠 재생(DRM)",
    description: "사이트가 DRM으로 보호된 미디어를 재생합니다.",
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
  "clipboard-read": "클립보드 읽기",
  "clipboard-sanitized-write": "클립보드 쓰기",
  "display-capture": "화면 공유",
  fullscreen: "전체 화면",
  geolocation: "위치",
  "idle-detection": "사용 여부 감지",
  media: "카메라 및 마이크",
  mediaKeySystem: "보호된 콘텐츠 재생(DRM)",
  midi: "MIDI",
  midiSysex: "MIDI SysEx",
  notifications: "알림",
  pointerLock: "포인터 잠금",
  keyboardLock: "키보드 잠금",
  openExternal: "외부 앱 열기",
  "speaker-selection": "스피커 선택",
  "storage-access": "저장소 접근",
  "top-level-storage-access": "최상위 저장소 접근",
  "window-management": "창 배치",
  unknown: "알 수 없는 권한",
  fileSystem: "파일 접근",
};

/**
 * Returns the Korean label for a given BrowserPermissionKind.
 *
 * Always returns a string — falls back to the raw permission key if the map
 * is somehow missing an entry (defensive for forward-compatibility).
 */
export function permissionLabel(permission: BrowserPermissionKind): string {
  return PERMISSION_LABEL_MAP[permission] ?? permission;
}
