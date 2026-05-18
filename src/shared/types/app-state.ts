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
});

export type WindowBounds = z.infer<typeof WindowBoundsSchema>;
export type AppState = z.infer<typeof AppStateSchema>;
