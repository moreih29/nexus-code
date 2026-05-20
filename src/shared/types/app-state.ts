import { z } from "zod";
import { WorkspaceLayoutSnapshotSchema } from "./layout";

// ThemeId is the single source of truth — imported from design-tokens so the
// zod enum stays in sync with the runtime registry without duplication.
// design.md §8 decision: "ThemeId를 shared 단일소스로 참조 — zod enum 이중정의 금지"
export const ThemePreferenceSchema = z.enum(["warm-dark", "cool-dark", "warm-light", "system"]);
export type ThemePreference = z.infer<typeof ThemePreferenceSchema>;

export const WindowBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const AppStateSchema = z.object({
  windowBounds: WindowBoundsSchema.optional(),
  lastActiveWorkspaceId: z.string().optional(),
  sidebarWidth: z.number().int().positive().optional(),
  filesPanelWidth: z.number().int().positive().optional(),
  layoutByWorkspace: z.record(z.string().uuid(), WorkspaceLayoutSnapshotSchema).optional(),
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
  editorFontLineHeight: z
    .union([z.literal(1.0), z.literal(1.2), z.literal(1.4)])
    .optional(),

  // Terminal font size in px — integer, clamped to [8, 32]; 부재=토큰 fallback (14).
  // Widened from a closed set so the Settings dialog can offer a numeric
  // stepper instead of a discrete slider.
  terminalFontSize: z.number().int().min(8).max(32).optional(),

  // Terminal cursor style — 닫힌 집합; 부재=토큰 fallback ('block').
  terminalCursorStyle: z.enum(["block", "underline", "bar"]).optional(),
});

export type WindowBounds = z.infer<typeof WindowBoundsSchema>;
export type AppState = z.infer<typeof AppStateSchema>;
