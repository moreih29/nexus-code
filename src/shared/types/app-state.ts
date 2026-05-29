import { z } from "zod";
import { THEME_SOURCES } from "../design-tokens";
import { WorkspaceLayoutSnapshotSchema } from "./layout";

// ThemePreferenceSchema mirrors the registered ThemeId set. The "system"
// preference was retired when external themes replaced the first-party
// warm/cool pair (only one light variant ships, so OS Auto can't pick a
// matching dark partner deterministically).
// design.md §8 decision: "ThemeId를 shared 단일소스로 참조 — zod enum 이중정의 금지"
const themeIds = THEME_SOURCES.map((s) => s.id) as [string, ...string[]];
export const ThemePreferenceSchema = z.enum(themeIds);
export type ThemePreference = z.infer<typeof ThemePreferenceSchema>;

export const WindowBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

// Closed set of language IDs that can be enabled per workspace for LSP.
// Mirrors BUILTIN_LSP_PRESETS — update both when new language servers ship.
export const LspLanguageIdSchema = z.enum(["typescript", "python"]);
export type LspLanguageId = z.infer<typeof LspLanguageIdSchema>;

export const AppStateSchema = z.object({
  windowBounds: WindowBoundsSchema.optional(),
  lastActiveWorkspaceId: z.string().optional(),
  sidebarWidth: z.number().int().positive().optional(),
  filesPanelWidth: z.number().int().positive().optional(),
  // Sidebar (workspace switcher strip) hidden state. Persisted so a
  // restart preserves the layout the user last chose. Absent = visible.
  sidebarHidden: z.boolean().optional(),
  // Files panel (tree/git/search column) hidden state. Persisted
  // independently of `sidebarHidden`; both toggle together only via the
  // ⌘⇧B command, never via storage coupling.
  filesPanelHidden: z.boolean().optional(),
  layoutByWorkspace: z.record(z.string().uuid(), WorkspaceLayoutSnapshotSchema).optional(),
  // Per-workspace list of LSP languages the user has explicitly enabled.
  // Key = workspaceId (UUID). Absent key (or absent field) means no
  // languages enabled (default OFF). Optional rather than `.default({})`
  // so the inferred output type matches the rest of the schema's
  // optional-field convention — every consumer of `AppState` already
  // narrows undefined → empty record at the call site.
  lspEnabledLanguagesByWorkspace: z
    .record(z.string().uuid(), z.array(LspLanguageIdSchema))
    .optional(),
  // Theme preference persisted to appState (authoritative store).
  // localStorage is also written as a boot cache for FOUC prevention.
  themePreference: ThemePreferenceSchema.optional(),
  // Window opacity (0–1). 1 = fully opaque (default, omitted from storage).
  // Mirrors Ghostty's background-opacity semantics.
  // Changing this requires an app restart — `transparent` is constructor-only in Electron.
  windowOpacity: z.number().min(0).max(1).optional(),

  // UI density — 닫힌 집합; 부재=토큰 fallback ('default').
  density: z.enum(["default", "compact"]).optional(),

  // Editor font size in px — integer, clamped to [8, 32]; 부재=토큰 fallback (16).
  // Widened from a closed set so the Settings dialog can offer a numeric
  // stepper instead of a discrete slider (user-driven UX change).
  editorFontSize: z.number().int().min(8).max(32).optional(),

  // Editor font family — sanitize: CSS injection 차단 (/^[A-Za-z0-9\s,'"]+$/); 부재=토큰 fallback.
  editorFontFamily: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9\s,'"]+$/)
    .optional(),

  // Editor font ligatures toggle — 부재=토큰 fallback (false).
  editorFontLigatures: z.boolean().optional(),

  // Editor line height — 닫힌 집합; 부재=토큰 fallback (1.4).
  editorFontLineHeight: z.union([z.literal(1.0), z.literal(1.2), z.literal(1.4)]).optional(),

  // Terminal font size in px — integer, clamped to [8, 32]; 부재=토큰 fallback (14).
  // Widened from a closed set so the Settings dialog can offer a numeric
  // stepper instead of a discrete slider.
  terminalFontSize: z.number().int().min(8).max(32).optional(),

  // Terminal cursor style — 닫힌 집합; 부재=토큰 fallback ('block').
  terminalCursorStyle: z.enum(["block", "underline", "bar"]).optional(),

  // Terminal font family — editor와 독립. sanitize: CSS injection 차단
  // (/^[A-Za-z0-9\s,'"]+$/); 부재=토큰 fallback (monoDisplay).
  terminalFontFamily: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9\s,'"]+$/)
    .optional(),

  // Terminal font ligatures toggle — editor와 독립; 부재=토큰 fallback (false).
  terminalFontLigatures: z.boolean().optional(),

  // Update channel — "stable" follows non-prerelease tags only; "beta" also
  // includes prerelease tags (e.g. v1.2.0-beta.1).  Defaults to "stable".
  updateChannel: z.enum(["stable", "beta"]).default("stable"),

  // Version string that the user chose to ignore.  When the poller finds this
  // version as the latest, the statusChanged event is suppressed silently.
  // Reset to null when the user changes updateChannel.
  ignoredUpdateVersion: z.string().nullable().default(null),

  // Auto-check toggle. When true (default), the updates domain fires one
  // silent GH Releases poll at app startup and surfaces a toast if a newer
  // version is available. When false, the auto-poll is skipped entirely;
  // the user can still trigger a manual check from the About panel or the
  // App menu — manual triggers always respond regardless of this setting.
  autoCheckForUpdates: z.boolean().default(true),

  // OS-level desktop notifications master toggle. When true (default), the
  // claude hook handler fires Electron `Notification`s on Notification /
  // PermissionRequest / Stop hooks while the user is not viewing the active
  // tab. When false, all three pathways are suppressed at the single
  // `fireOsNotification` gate. The in-app status broker (sidebar indicator
  // glyphs, attention badges) is unaffected — only OS-level notifications.
  osNotificationsEnabled: z.boolean().default(true),

  // Global browser permission toggles keyed by BrowserPermissionKind string.
  // Absent key (or absent field) means the permission is OFF (denied).
  // z.record key is z.string() for runtime compatibility; callers narrow the
  // key type to BrowserPermissionKind at usage sites.
  browserPermissionGrants: z.record(z.string(), z.boolean()).optional(),
});

export type WindowBounds = z.infer<typeof WindowBoundsSchema>;
export type AppState = z.infer<typeof AppStateSchema>;
