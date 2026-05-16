// themes/index.ts — Theme registry and ThemeId type.
//
// Single source of truth for available theme IDs and their token sets.
// Consumers import ThemeId + THEMES from here; they do not import individual
// theme files directly (except generate-theme-css.ts which builds the CSS).
//
// design.md §8 초기 테마 셋 (T2):
//   warm-dark  — flagship default (h≈90-110, dark)
//   cool-dark  — explicit selection, OS tracking disabled (h≈240-250, dark)
//   warm-light — OS Auto pair with warm-dark (same hue family, light)

import type { SemanticTokenSet } from "../semantic";
import { coolDark } from "./cool-dark";
import { warmDark } from "./warm-dark";
import { warmLight } from "./warm-light";

// ---------------------------------------------------------------------------
// ThemeId — string union of all registered theme identifiers.
// Add new themes here AND in THEMES below simultaneously.
// ---------------------------------------------------------------------------

export type ThemeId = "warm-dark" | "cool-dark" | "warm-light";

// ---------------------------------------------------------------------------
// THEMES — runtime registry: ThemeId → SemanticTokenSet.
// generate-theme-css.ts iterates this map to emit [data-theme="*"] blocks.
// ---------------------------------------------------------------------------

export const THEMES: Record<ThemeId, SemanticTokenSet> = {
  "warm-dark": warmDark,
  "cool-dark": coolDark,
  "warm-light": warmLight,
};

// ---------------------------------------------------------------------------
// DEFAULT_THEME — the theme applied on first load and as the :root fallback.
// Must be a valid ThemeId. OS Auto pair: warm-dark ⇄ warm-light.
// ---------------------------------------------------------------------------

export const DEFAULT_THEME: ThemeId = "warm-dark";

// Re-export individual themes for direct access (e.g. Monaco palette builder).
export { warmDark, coolDark, warmLight };
