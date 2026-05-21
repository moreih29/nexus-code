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
});

export type WindowBounds = z.infer<typeof WindowBoundsSchema>;
export type AppState = z.infer<typeof AppStateSchema>;
